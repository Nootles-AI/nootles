import * as Y from "yjs";
import type { NmlIssue } from "./schema";
import { validateDocument } from "./validate";
import {
  decodeNmlDocument,
  NML_YJS_ENCODING_VERSION,
  NML_YJS_ROOT,
  NmlYjsDecodeError,
} from "./yjs";

/**
 * Step 13 — the DOM-free half of "switch to NML authority": re-assert a
 * persisted canonical root independently of the client that wrote it.
 *
 * Step 12's `electMigration` trusts the elected client's `equivalenceOk` /
 * `limitOk` verdict and its update bytes, because the conversion those verdicts
 * come from needs BlockNote and a DOM and cannot run on the server. That is
 * acceptable while the NML root is not served. Before authority moves to it,
 * though, the plan requires the backend to confirm the stored root is well-
 * formed and within limits on its own — and decoding an already-canonical root
 * and running `validateDocument` need no DOM. So this module lives apart from
 * `persistence.ts`/`legacy.ts` (which pull in `linkedom` and the BlockNote
 * converter) and imports only the decoder, the validator, and the schema, so a
 * Convex function can bundle it without dragging a DOM shim into the isolate.
 */

/** Diagnostic codes `validateDocument` emits for the four v1 size limits. */
export const NML_LIMIT_CODES: ReadonlySet<string> = new Set([
  "block_depth_limit",
  "block_count_limit",
  "inline_size_limit",
  "domain_size_limit",
]);

/** Split blocking (error-severity) diagnostics into limit vs. everything else. */
export function partitionDiagnostics(diagnostics: readonly NmlIssue[]): {
  limitViolations: NmlIssue[];
  conversionErrors: NmlIssue[];
} {
  const limitViolations: NmlIssue[] = [];
  const conversionErrors: NmlIssue[] = [];
  for (const issue of diagnostics) {
    if (issue.severity !== "error") continue;
    if (NML_LIMIT_CODES.has(issue.code)) limitViolations.push(issue);
    else conversionErrors.push(issue);
  }
  return { limitViolations, conversionErrors };
}

/**
 * Why a stored NML root is or is not safe for a cohort to be served. Every value
 * is content-free (a classification plus diagnostic codes), so the verdict can
 * be logged and persisted without carrying document text.
 */
export type NmlRootVerification = {
  /** True only when the root decodes at this version AND is within all limits. */
  ok: boolean;
  reason: "verified" | "no-root" | "unsupported" | "limit-exceeded" | "invalid";
  /** Declared versions of the decoded root; null when there is nothing to read. */
  schemaVersion: number | null;
  encodingVersion: number | null;
  /** Distinct v1 size-limit codes the root violates (content-free). */
  limitCodes: string[];
  /** Distinct other blocking validation codes (content-free). */
  errorCodes: string[];
};

function rebuildDoc(updates: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Reconstruct the document from the stored `nml` root and re-assert schema
 * version, encoding version, and the four v1 size limits. A newer or malformed
 * root fails closed to `unsupported` (the frozen v1 read-only decision — never
 * normalize or downgrade-write it); a decodable root that exceeds a limit is
 * `limit-exceeded`. Only a `verified` verdict clears a cohort to read the root.
 */
export function verifyStoredNmlRoot(updates: readonly Uint8Array[]): NmlRootVerification {
  const doc = rebuildDoc(updates);
  try {
    if (doc.getMap<unknown>(NML_YJS_ROOT).size === 0) {
      return { ok: false, reason: "no-root", schemaVersion: null, encodingVersion: null, limitCodes: [], errorCodes: [] };
    }
    let document;
    try {
      document = decodeNmlDocument(doc);
    } catch (error) {
      if (error instanceof NmlYjsDecodeError) {
        return { ok: false, reason: "unsupported", schemaVersion: null, encodingVersion: null, limitCodes: [], errorCodes: [] };
      }
      throw error;
    }
    // A successful decode has already asserted the encoding version equals this
    // runtime's (it fails closed otherwise), so the encoding is supported; the
    // schema version rides on the decoded document.
    const { limitViolations, conversionErrors } = partitionDiagnostics(validateDocument(document));
    const limitCodes = [...new Set(limitViolations.map((issue) => issue.code))];
    const errorCodes = [...new Set(conversionErrors.map((issue) => issue.code))];
    const ok = limitCodes.length === 0 && errorCodes.length === 0;
    return {
      ok,
      reason: ok ? "verified" : limitCodes.length ? "limit-exceeded" : "invalid",
      schemaVersion: document.schemaVersion,
      encodingVersion: NML_YJS_ENCODING_VERSION,
      limitCodes,
      errorCodes,
    };
  } finally {
    doc.destroy();
  }
}
