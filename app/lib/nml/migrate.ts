import { NML_SCHEMA_VERSION, type NmlDocument } from "./schema";
import { normalizeDocument } from "./normalize";
import { assertValidDocument } from "./validate";

export class NmlMigrationError extends Error {
  constructor(readonly fromVersion: number, message: string) {
    super(message);
    this.name = "NmlMigrationError";
  }
}

type VersionedDocument = { schemaVersion: number; documentId: string; blocks: unknown[] };
type Migration = (document: VersionedDocument) => VersionedDocument;

// Intentionally empty for the first schema. Each future entry is a pure vN -> vN+1
// function and must ship with before/after fixtures.
const migrations: Readonly<Record<number, Migration>> = {};

export function migrateDocument(input: VersionedDocument): NmlDocument {
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new NmlMigrationError(input.schemaVersion, "NML documents before schema v1 have no implicit migration; use the explicit legacy converter.");
  }
  if (input.schemaVersion > NML_SCHEMA_VERSION) {
    throw new NmlMigrationError(input.schemaVersion, `Schema v${input.schemaVersion} is newer than supported v${NML_SCHEMA_VERSION}.`);
  }
  let current = structuredClone(input);
  while (current.schemaVersion < NML_SCHEMA_VERSION) {
    const migration = migrations[current.schemaVersion];
    if (!migration) throw new NmlMigrationError(current.schemaVersion, `No migration from schema v${current.schemaVersion}.`);
    const migrated = migration(current);
    if (migrated.schemaVersion !== current.schemaVersion + 1) {
      throw new NmlMigrationError(current.schemaVersion, "Migration did not advance exactly one schema version.");
    }
    current = migrated;
  }
  assertValidDocument(current);
  return normalizeDocument(current);
}
