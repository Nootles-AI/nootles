/**
 * The Node half of mcp.fullstack.mjs that needs app code: the real headless
 * migration engine (what a signed-in browser runs before `electMigration`) and
 * the real NML executor (what a collaborator's edit compiles to). Bundled by
 * esbuild for Node; nothing here talks to a backend.
 */
import { DOMParser } from "linkedom";
import * as Y from "yjs";
import { executeNmlCommands, migrateStoredDocument, type LegacyBlock, type NmlCommand } from "../app/lib/nml";
import { decodeNmlDocument } from "../app/lib/nml/yjs";
import { splitUpdate } from "../convex/yshape";

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;

const toBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** The NML root a browser would write for `blocks`, ready for `electMigration`. */
export function migration(documentId: string, blocks: LegacyBlock[]) {
  let n = 0;
  const result = migrateStoredDocument({ baseUpdates: [], blocks, documentId, options: { createId: () => `gen-${++n}` } });
  if (result.status !== "migrated") throw new Error(`migration rejected: ${result.reason}`);
  return {
    chunks: splitUpdate(result.update),
    nmlSchemaVersion: result.schemaVersion,
    nmlEncodingVersion: result.encodingVersion,
    equivalenceOk: true,
    mismatchClasses: [] as string[],
    limitOk: true,
  };
}

/** A collaborator's edit: `commands` applied to the stored document, as the update to append. */
export async function edit(documentId: string, stored: ArrayBuffer[], commands: NmlCommand[], userId: string) {
  const doc = new Y.Doc();
  for (const update of stored) Y.applyUpdate(doc, new Uint8Array(update));
  const before = Y.encodeStateVector(doc);
  await executeNmlCommands({
    doc,
    documentId,
    commands,
    origin: { version: 1, transactionId: `tx-${Date.now()}`, actor: { userId, kind: "human" }, command: "e2e" },
    idempotencyKey: `e2e-${Date.now()}`,
    authorize: () => true,
  });
  return toBuffer(Y.encodeStateAsUpdate(doc, before));
}

/** The decoded canonical document, for checking what the backend holds. */
export function decode(stored: ArrayBuffer[]) {
  const doc = new Y.Doc();
  for (const update of stored) Y.applyUpdate(doc, new Uint8Array(update));
  return decodeNmlDocument(doc);
}
