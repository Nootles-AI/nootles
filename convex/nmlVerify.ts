"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { verifyStoredNmlRoot } from "@/app/lib/nml/verify";

/**
 * Step 13 — the server-side re-assertion of a migrated root, run in Node.
 *
 * `electMigration` trusts the elected client's `equivalenceOk`/`limitOk` and
 * its update bytes, because the conversion those verdicts come from needs a
 * DOM. Before authority moves to the root, the backend must confirm on its own
 * that the persisted root is well-formed and within the v1 limits — decoding a
 * canonical root and validating it need no DOM. But reconstructing and decoding
 * a document near the block/inline limits costs well over a hundred megabytes
 * of heap, which a query/mutation isolate cannot hold, so this runs as a Node
 * action: it reads the raw update bytes through a cheap isolate query, does the
 * heavy decode + validate here in Node, and records the verdict through a
 * mutation. A lying client, a corrupt root, or one too large to read all fail
 * closed to "not served".
 */
export const run = internalAction({
  args: { docId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const material = await ctx.runQuery(internal.nmlMigration.verifyMaterial, { docId: args.docId });
    if (material.status !== "ok") {
      await ctx.runMutation(internal.nmlMigration.recordVerification, {
        docId: args.docId,
        ok: false,
        reason: material.status === "no-doc" ? "no-doc" : "too-large",
      });
      return null;
    }

    let verdict;
    try {
      verdict = verifyStoredNmlRoot(material.updates.map((b) => new Uint8Array(b)));
    } catch {
      // Un-appliable bytes (a forged or truncated update) fail closed.
      await ctx.runMutation(internal.nmlMigration.recordVerification, { docId: args.docId, ok: false, reason: "corrupt" });
      return null;
    }

    await ctx.runMutation(internal.nmlMigration.recordVerification, {
      docId: args.docId,
      ok: verdict.ok,
      ...(verdict.ok ? {} : { reason: verdict.reason }),
      ...(verdict.schemaVersion !== null ? { schemaVersion: verdict.schemaVersion } : {}),
      ...(verdict.encodingVersion !== null ? { encodingVersion: verdict.encodingVersion } : {}),
    });
    return null;
  },
});
