import * as Y from "yjs";
import {
  canvasSceneFromMaps,
  compareLegacyToNml,
  compareScenes,
  convertLegacyDocument,
  type LegacyBlock,
  type LegacyComparison,
  type LegacyConvertOptions,
  type LegacyMismatch,
} from "./legacy";
import { NML_SCHEMA_VERSION, type NmlDocument, type NmlIssue } from "./schema";
import { partitionDiagnostics } from "./verify";
import {
  decodeNmlDocument,
  NML_YJS_ENCODING_VERSION,
  NML_YJS_ROOT,
  NmlYjsDecodeError,
  type NmlTransactionOrigin,
  writeNmlDocument,
} from "./yjs";

/**
 * Step 12 — persistence and cohort migration.
 *
 * This is the headless half of "the elected migrator". It converts a legacy
 * page (BlockNote blocks plus its live canvas maps, both already carried by the
 * page's Y.Doc) into the canonical NML root, and returns the single Yjs update
 * that ADDS that root beside the existing `prosemirror` root and `canvas:*`
 * maps. Nothing here writes to Convex or serves NML; a Convex mutation elects
 * one writer and appends this update through the ordinary chunked log, so the
 * NML root rides the same snapshot/compaction/provider machinery the plan says
 * to keep. The legacy ProseMirror root stays the served truth until step 13.
 *
 * DOM is injected (linkedom in Node, the platform parser in the browser) so the
 * core stays runtime-neutral, exactly like the step-5 converter it builds on.
 */

export type MigrationInput = {
  /** All stored updates for the page (snapshot chunks and log updates, any order). */
  baseUpdates: readonly Uint8Array[];
  /** BlockNote blocks for the same page — from `blocksFromYUpdates` or a fixture. */
  blocks: LegacyBlock[];
  /** Stable document identity; the page's docId. */
  documentId: string;
  options?: LegacyConvertOptions;
  origin?: NmlTransactionOrigin;
};

export type MigrationReport = {
  /** Structure / ID / inline-semantic parity re-derived from the raw legacy tree. */
  equivalence: LegacyComparison;
  /** Per-canvas-block parity between the live per-shape maps and the converted scene. */
  canvasMismatches: LegacyMismatch[];
  /** `validateDocument` errors that are one of the four size limits. */
  limitViolations: NmlIssue[];
  /** Any other blocking conversion error (a converter bug, not an understood gap). */
  conversionErrors: NmlIssue[];
  /** True only when every check passed: safe to persist as a migration-ready root. */
  ok: boolean;
};

export type MigrationResult =
  | {
      status: "migrated";
      /** The delta update that adds the NML root; append it to the page's log. */
      update: Uint8Array;
      document: NmlDocument;
      report: MigrationReport;
      schemaVersion: number;
      encodingVersion: number;
    }
  | { status: "rejected"; reason: string; report: MigrationReport };

function rebuildDoc(updates: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

/** True when a page's Y.Doc already carries a canonical NML root. */
export function nmlRootPresent(updates: readonly Uint8Array[]): boolean {
  const doc = rebuildDoc(updates);
  const present = doc.getMap<unknown>(NML_YJS_ROOT).size > 0;
  doc.destroy();
  return present;
}

/**
 * The NML root's declared versions without a full decode, for a mixed-version
 * reader deciding read-only downgrade. `null` when there is no NML root yet.
 */
export function storedNmlVersions(
  updates: readonly Uint8Array[],
): { encodingVersion: number; schemaVersion: number } | null {
  const doc = rebuildDoc(updates);
  const root = doc.getMap<unknown>(NML_YJS_ROOT);
  if (root.size === 0) {
    doc.destroy();
    return null;
  }
  const encodingVersion = Number(root.get("encodingVersion"));
  const schemaVersion = Number(root.get("schemaVersion"));
  doc.destroy();
  return { encodingVersion, schemaVersion };
}

export type StoredNmlRead =
  | { status: "ok"; document: NmlDocument }
  | { status: "none" }
  | { status: "unsupported"; reason: string };

/**
 * The mixed-version reader: decode the canonical NML root if one is present and
 * this runtime understands its version. A newer schema/encoding fails closed to
 * `unsupported` — the reader must treat the document as read-only rather than
 * normalize or downgrade-write it (the frozen v1 decision).
 */
export function readStoredNml(updates: readonly Uint8Array[]): StoredNmlRead {
  const doc = rebuildDoc(updates);
  try {
    if (doc.getMap<unknown>(NML_YJS_ROOT).size === 0) return { status: "none" };
    return { status: "ok", document: decodeNmlDocument(doc) };
  } catch (error) {
    if (error instanceof NmlYjsDecodeError) return { status: "unsupported", reason: error.message };
    throw error;
  } finally {
    doc.destroy();
  }
}

/**
 * Canvas parity: the converter reads the `<nt-diagram>` block-prop mirror, while
 * the live truth is the per-shape CRDT maps. They are kept in lockstep in
 * production, so any structural divergence is a real fault, not an understood
 * gap. A block with no live map state (never opened collaboratively) has only
 * the mirror, so it is skipped rather than reported.
 */
function canvasParity(document: NmlDocument, doc: Y.Doc): LegacyMismatch[] {
  const out: LegacyMismatch[] = [];
  const walk = (blocks: readonly NmlDocument["blocks"][number][]) => {
    for (const block of blocks) {
      if (block.type === "canvas") {
        const live = canvasSceneFromMaps(doc, block.id);
        if (live) {
          for (const mismatch of compareScenes(block.scene, live)) {
            out.push({ ...mismatch, understood: false });
          }
        }
      }
      if (block.children.length) walk(block.children);
    }
  };
  walk(document.blocks);
  return out;
}

/**
 * Convert one stored page into the NML root and return the update that adds it.
 * Rejects (writing nothing) when equivalence, limits, canvas parity, or the
 * converter itself fail — the gate for marking a document migration-ready.
 */
export function migrateStoredDocument(input: MigrationInput): MigrationResult {
  const doc = rebuildDoc(input.baseUpdates);
  try {
    const legacyInput = { documentId: input.documentId, blocks: input.blocks };
    const conversion = convertLegacyDocument(legacyInput, input.options);
    const { document } = conversion;
    const equivalence = compareLegacyToNml(legacyInput, document, input.options);
    const canvasMismatches = canvasParity(document, doc);
    const { limitViolations, conversionErrors } = partitionDiagnostics(conversion.diagnostics);
    const ok =
      equivalence.ok &&
      canvasMismatches.length === 0 &&
      limitViolations.length === 0 &&
      conversionErrors.length === 0;
    const report: MigrationReport = { equivalence, canvasMismatches, limitViolations, conversionErrors, ok };

    if (!ok) return { status: "rejected", reason: rejectionReason(report), report };
    if (doc.getMap<unknown>(NML_YJS_ROOT).size > 0) {
      return { status: "rejected", reason: "already-migrated", report };
    }

    const before = Y.encodeStateVector(doc);
    writeNmlDocument(doc, document, input.origin);
    const update = Y.encodeStateAsUpdate(doc, before);
    return {
      status: "migrated",
      update,
      document,
      report,
      schemaVersion: NML_SCHEMA_VERSION,
      encodingVersion: NML_YJS_ENCODING_VERSION,
    };
  } finally {
    doc.destroy();
  }
}

function rejectionReason(report: MigrationReport): string {
  if (report.limitViolations.length) return "limit-exceeded";
  if (report.conversionErrors.length) return "conversion-error";
  if (report.canvasMismatches.length) return "canvas-divergence";
  if (!report.equivalence.ok) return "equivalence-failed";
  return "not-ready";
}

export type NmlDivergence = {
  /** True when the stored NML root holds content re-conversion cannot reproduce. */
  diverged: boolean;
  reason: "no-nml-root" | "newer-schema" | "in-sync" | "nml-only-edits";
  /** A short, content-free classification for the rollback report. */
  detail: string;
};

/**
 * Rollback safety check. The NML root persists forever once written (Yjs roots
 * are permanent), so returning authority to legacy never destroys NML content —
 * but the plan requires rollback to be explicit about "NML edits legacy PM
 * cannot represent". This asks whether the stored root is still semantically
 * what the current legacy blocks convert to; if not, it carries NML-only edits
 * the legacy tree does not, and the caller must record that they remain
 * recoverable rather than silently drop them.
 *
 * It compares through `compareLegacyToNml`, not raw serialization: minted IDs
 * for BlockNote's position-only entities (inline embeds, table cells) are
 * non-deterministic across conversions, so a serialization equality would
 * report every document with a table or inline math as diverged. The semantic
 * comparator is mint-insensitive and treats the understood `unsupported-block`
 * gap as in-sync rather than a divergence.
 */
export function detectNmlDivergence(input: {
  baseUpdates: readonly Uint8Array[];
  blocks: LegacyBlock[];
  options?: LegacyConvertOptions;
}): NmlDivergence {
  const stored = readStoredNml(input.baseUpdates);
  if (stored.status === "none") return { diverged: false, reason: "no-nml-root", detail: "no canonical root" };
  if (stored.status === "unsupported") {
    return { diverged: true, reason: "newer-schema", detail: "root is a newer schema this runtime cannot compare" };
  }
  const comparison = compareLegacyToNml(
    { documentId: stored.document.documentId, blocks: input.blocks },
    stored.document,
    input.options,
  );
  return comparison.ok
    ? { diverged: false, reason: "in-sync", detail: "root matches a fresh legacy conversion" }
    : { diverged: true, reason: "nml-only-edits", detail: "root holds edits absent from the legacy tree" };
}
