"use client";

import { useEffect } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { splitUpdate } from "@/convex/yshape";
import { migrateStoredDocument, type MigrationReport } from "@/app/lib/nml/persistence";
import type { LegacyBlock } from "@/app/lib/nml/legacy";
import { readYDocUpdates } from "@/app/lib/sync/ydocRead";

/**
 * Step 13 — the client half of the elected migrator, run from the still-legacy
 * editor for a cohort document that has not been migrated yet. It converts the
 * live BlockNote blocks plus the page's stored Yjs updates into the canonical
 * NML root (the DOM-dependent work that cannot run on the server) and elects it
 * through `electMigration`; the server then verifies it independently and, once
 * `nmlAuthority` flips, `Editor.tsx` remounts the complete surface with NML
 * authority and the compatibility mirror.
 *
 * Gated by `enabled` (the reactive `nmlServeEnabled` master switch) and cohort
 * membership, so it is dormant until serving is turned on and a cohort is
 * enrolled. First-writer-wins on
 * the server means several open clients may all attempt this; only one lands.
 */

/** Once per doc per session, and StrictMode-safe (the double invoke shares this). */
const attempted = new Set<string>();

function mismatchClasses(report: MigrationReport): string[] {
  return [...new Set(report.equivalence.mismatches.map((mismatch) => mismatch.class))];
}

export function useNmlMigration(
  enabled: boolean,
  docId: string,
  getBlocks: () => LegacyBlock[] | null,
): void {
  const client = useConvex();
  const inCohort = useQuery(api.nmlMigration.inCohort, enabled ? { docId } : "skip");
  const state = useQuery(api.nmlMigration.nmlState, enabled ? { docId } : "skip");

  useEffect(() => {
    if (!enabled || inCohort !== true) return;
    // `undefined` = still loading; a non-null row = already elected or rolled
    // back (never re-elect a rolled-back doc).
    if (state === undefined || state !== null) return;
    if (attempted.has(docId)) return;
    attempted.add(docId);

    void (async () => {
      try {
        const blocks = getBlocks();
        if (!blocks) {
          attempted.delete(docId);
          return;
        }
        const baseUpdates = await readYDocUpdates(client, docId);
        const result = migrateStoredDocument({ baseUpdates, blocks, documentId: docId });
        // A rejected conversion (an understood gap or a real fault) leaves the
        // document on legacy — never a partial or forced migration.
        if (result.status !== "migrated") return;
        await client.mutation(api.nmlMigration.electMigration, {
          docId,
          chunks: splitUpdate(result.update),
          nmlSchemaVersion: result.schemaVersion,
          nmlEncodingVersion: result.encodingVersion,
          equivalenceOk: result.report.equivalence.ok,
          mismatchClasses: mismatchClasses(result.report),
          limitOk: result.report.limitViolations.length === 0,
        });
      } catch {
        // A transient failure (offline, a lost race) may retry next mount.
        attempted.delete(docId);
      }
    })();
  }, [enabled, inCohort, state, docId, client, getBlocks]);
}
