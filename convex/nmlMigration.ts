import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { checkRead, checkWrite, pageForDoc } from "./prosemirror";
import { ownerId, requireOwned } from "./auth";
import { appendYUpdate } from "./ydoc";

/**
 * Step 12 — the Convex side of persistence and cohort migration.
 *
 * The heavy conversion (legacy blocks + canvas maps -> NML root delta, with the
 * equivalence report and limit checks) is the headless engine in
 * `app/lib/nml/persistence.ts`, run by the elected client which has BlockNote
 * and a DOM. This module owns the parts that are pure data and belong on the
 * server: electing one writer per document, gating by cohort, appending the
 * root through the ordinary Yjs wire path, exposing migration state to
 * mixed-version readers, and recording a rollback. It never serves NML and
 * never changes which root the editor reads — that is step 13.
 */

async function nmlStateRow(ctx: QueryCtx, docId: string) {
  return await ctx.db
    .query("nmlDocState")
    .withIndex("by_doc", (q) => q.eq("docId", docId))
    .unique();
}

/** Whether a document is covered by the migration cohort (by doc or by project). */
async function eligible(ctx: QueryCtx, docId: string): Promise<boolean> {
  // `.first()`, not `.unique()`: a benign concurrent double-add can leave two
  // rows for one key, and eligibility must not throw on that.
  const byDoc = await ctx.db
    .query("nmlCohorts")
    .withIndex("by_scope_and_key", (q) => q.eq("scope", "doc").eq("key", docId))
    .first();
  if (byDoc) return true;
  const page = await pageForDoc(ctx, docId);
  if (!page) return false;
  const byProject = await ctx.db
    .query("nmlCohorts")
    .withIndex("by_scope_and_key", (q) => q.eq("scope", "project").eq("key", page.projectId))
    .first();
  return byProject !== null;
}

/**
 * Authorize a cohort change: opting a single document in needs write access to
 * it; opting a whole project in needs ownership of the project. Both reuse the
 * one centralized authority rather than inventing a migration-only role.
 */
async function authorizeCohort(ctx: MutationCtx, scope: "project" | "doc", key: string): Promise<string> {
  if (scope === "doc") {
    await checkWrite(ctx, key);
    return (await ownerId(ctx)) ?? "anonymous";
  }
  const project = await requireOwned(ctx, "projects", key as Id<"projects">);
  return project.ownerId;
}

/** Is this document eligible to migrate? Subscribed to by a preparing client. */
export const inCohort = query({
  args: { docId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    return await eligible(ctx, args.docId);
  },
});

export const addToCohort = mutation({
  args: {
    scope: v.union(v.literal("project"), v.literal("doc")),
    key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const by = await authorizeCohort(ctx, args.scope, args.key);
    const existing = await ctx.db
      .query("nmlCohorts")
      .withIndex("by_scope_and_key", (q) => q.eq("scope", args.scope).eq("key", args.key))
      .first();
    if (existing) return null;
    await ctx.db.insert("nmlCohorts", {
      scope: args.scope,
      key: args.key,
      addedAt: Date.now(),
      addedBy: by,
    });
    return null;
  },
});

export const removeFromCohort = mutation({
  args: {
    scope: v.union(v.literal("project"), v.literal("doc")),
    key: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorizeCohort(ctx, args.scope, args.key);
    const existing = await ctx.db
      .query("nmlCohorts")
      .withIndex("by_scope_and_key", (q) => q.eq("scope", args.scope).eq("key", args.key))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/**
 * Persist the NML root, once, for a document in the cohort. First writer wins:
 * a second caller for the same document finds the state row and stands down,
 * so browsers may all compute a preview but never race a duplicate root. The
 * equivalence and limit gate must have passed on the elected client; a root
 * that failed either is refused rather than stored.
 */
export const electMigration = mutation({
  args: {
    docId: v.string(),
    /** The NML-root delta from `migrateStoredDocument`, whole or pre-split. */
    update: v.optional(v.bytes()),
    chunks: v.optional(v.array(v.bytes())),
    nmlSchemaVersion: v.number(),
    nmlEncodingVersion: v.number(),
    equivalenceOk: v.boolean(),
    mismatchClasses: v.array(v.string()),
    limitOk: v.boolean(),
  },
  returns: v.object({
    elected: v.boolean(),
    seq: v.optional(v.number()),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await checkWrite(ctx, args.docId);
    if (!(await eligible(ctx, args.docId))) {
      throw new Error("Document is not in the migration cohort");
    }
    if (await nmlStateRow(ctx, args.docId)) {
      // Already elected (or rolled back): stand down, do not write a second root.
      return { elected: false, reason: "already-elected" };
    }
    if (!args.equivalenceOk || !args.limitOk) {
      throw new Error("Refusing to persist a root that failed equivalence or limits");
    }
    const chunks = args.chunks ?? (args.update !== undefined ? [args.update] : []);
    if (!chunks.length) throw new Error("Nothing to migrate");

    const seq = await appendYUpdate(ctx, args.docId, chunks);
    await ctx.db.insert("nmlDocState", {
      docId: args.docId,
      status: "migrated",
      nmlSchemaVersion: args.nmlSchemaVersion,
      nmlEncodingVersion: args.nmlEncodingVersion,
      nmlSeq: seq,
      equivalenceOk: args.equivalenceOk,
      mismatchClasses: args.mismatchClasses,
      limitOk: args.limitOk,
      migratedAt: Date.now(),
      migratedBy: (await ownerId(ctx)) ?? "anonymous",
    });
    return { elected: true, seq };
  },
});

/**
 * The migration record for a document, or null. A mixed-version reader uses the
 * declared versions to decide whether it can read the root or must fall back to
 * read-only, and the status to know that authority still rests with legacy.
 */
export const nmlState = query({
  args: { docId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(v.literal("migrated"), v.literal("rolledBack")),
      nmlSchemaVersion: v.number(),
      nmlEncodingVersion: v.number(),
      nmlSeq: v.number(),
      equivalenceOk: v.boolean(),
      limitOk: v.boolean(),
      mismatchClasses: v.array(v.string()),
      migratedAt: v.number(),
      rolledBackAt: v.optional(v.number()),
      rollbackReason: v.optional(v.string()),
      rolledBackDiverged: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    const row = await nmlStateRow(ctx, args.docId);
    if (!row) return null;
    return {
      status: row.status,
      nmlSchemaVersion: row.nmlSchemaVersion,
      nmlEncodingVersion: row.nmlEncodingVersion,
      nmlSeq: row.nmlSeq,
      equivalenceOk: row.equivalenceOk,
      limitOk: row.limitOk,
      mismatchClasses: row.mismatchClasses,
      migratedAt: row.migratedAt,
      ...(row.rolledBackAt !== undefined ? { rolledBackAt: row.rolledBackAt } : {}),
      ...(row.rollbackReason !== undefined ? { rollbackReason: row.rollbackReason } : {}),
      ...(row.rolledBackDiverged !== undefined ? { rolledBackDiverged: row.rolledBackDiverged } : {}),
    };
  },
});

/**
 * Return authority to legacy for a migrated document. The NML root is left in
 * place — it is permanent and therefore recoverable — so this is metadata only:
 * it records that authority is legacy again and whether the root had diverged
 * (held NML-only edits) at the time, which the caller computes with
 * `detectNmlDivergence`. Because nothing is deleted, no NML-only edit is lost;
 * the downgrade is explicit, never silently lossy.
 */
export const rollback = mutation({
  args: {
    docId: v.string(),
    reason: v.string(),
    diverged: v.boolean(),
  },
  returns: v.object({ rolledBack: v.boolean(), diverged: v.boolean() }),
  handler: async (ctx, args) => {
    await checkWrite(ctx, args.docId);
    const row = await nmlStateRow(ctx, args.docId);
    if (!row || row.status !== "migrated") {
      throw new Error("Document has no active migration to roll back");
    }
    await ctx.db.patch(row._id, {
      status: "rolledBack",
      rolledBackAt: Date.now(),
      rollbackReason: args.reason,
      rolledBackDiverged: args.diverged,
    });
    return { rolledBack: true, diverged: args.diverged };
  },
});
