import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkRead, checkWrite, pageForDoc } from "./prosemirror";
import { ownerId, requireManageable, requireOwner } from "./auth";
import { appendYUpdate, readStoredUpdates } from "./ydoc";
import { NML_SCHEMA_VERSION } from "@/app/lib/nml/schema";
import { NML_YJS_ENCODING_VERSION } from "@/app/lib/nml/yjs";

/**
 * Step 12 — the Convex side of persistence and cohort migration.
 *
 * The heavy conversion (legacy blocks + canvas maps -> NML root delta, with the
 * equivalence report and limit checks) is the headless engine in
 * `app/lib/nml/persistence.ts`, run by the elected client which has BlockNote
 * and a DOM. This module owns the parts that are pure data and belong on the
 * server: electing one writer per document, gating by cohort, appending the
 * root through the ordinary Yjs wire path, exposing migration state to
 * mixed-version readers, and recording a rollback.
 *
 * Step 13 adds the authority gate on top: `verifyMigration` reconstructs the
 * stored root on the server and re-asserts it with `verifyStoredNmlRoot`
 * (independently of the elected client's claim), and `nmlAuthority` grants a
 * cohort permission to *read* NML only once that server check has passed. The
 * elected client still writes the bytes and computes equivalence — that half
 * needs a DOM — but nothing is served on the client's word alone.
 */

async function nmlStateRow(ctx: QueryCtx, docId: string) {
  return await ctx.db
    .query("nmlDocState")
    .withIndex("by_doc", (q) => q.eq("docId", docId))
    .unique();
}

/**
 * Is this Clerk subject on the internal-owner allowlist? A listed subject's
 * documents are all migration-eligible (owned-only), current and future.
 * `.first()`, not `.unique()`: a benign concurrent double-add can leave two rows
 * for one subject, and eligibility must not throw on that.
 */
async function isInternalOwner(ctx: QueryCtx, subject: string): Promise<boolean> {
  const row = await ctx.db
    .query("internalOwners")
    .withIndex("by_subject", (q) => q.eq("subject", subject))
    .first();
  return row !== null;
}

/**
 * Whether a document is eligible to migrate — covered by the cohort (by doc or
 * by project) or owned by an internal subject.
 */
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
  // The internal-owner allowlist: any document OWNED by an internal subject is
  // eligible, so the founding team's docs (current and future) migrate without
  // per-project enrollment. Owned-only by construction — this keys on the page's
  // own owner, so a doc a member can merely edit but does not own is not theirs.
  // Only in a personal project: a workspace project's `ownerId` is its creator,
  // who owns nothing there (`auth.seatRole`) and may since have lost their
  // seat, so a workspace's documents opt in through the cohort alone.
  const project = await ctx.db.get(page.projectId);
  if (project && !project.workspaceId && (await isInternalOwner(ctx, page.ownerId))) return true;
  const byProject = await ctx.db
    .query("nmlCohorts")
    .withIndex("by_scope_and_key", (q) => q.eq("scope", "project").eq("key", page.projectId))
    .first();
  return byProject !== null;
}

/**
 * Authorize a cohort change: opting a single document in needs write access to
 * it; opting a whole project in needs the right to manage the project. Both
 * reuse the one centralized authority rather than inventing a migration-only
 * role.
 */
async function authorizeCohort(ctx: MutationCtx, scope: "project" | "doc", key: string): Promise<string> {
  if (scope === "doc") {
    await checkWrite(ctx, key);
    return (await ownerId(ctx)) ?? "anonymous";
  }
  const projectId = ctx.db.normalizeId("projects", key);
  if (!projectId) throw new Error("Not found");
  await requireManageable(ctx, "projects", projectId);
  return await requireOwner(ctx);
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
 * Enroll a Clerk subject as an internal owner, making all of their documents
 * migration-eligible (and, later, MCP-reachable). Internal by design: an
 * operator runs this through `convex run` under deploy auth — the allowlist is
 * an infrastructure control that widens the agent's reach, so nothing an end
 * user can call touches it. Idempotent: re-adding a listed subject inserts no
 * duplicate and reports `added: false`.
 */
export const addInternalOwner = internalMutation({
  args: { subject: v.string(), note: v.optional(v.string()) },
  returns: v.object({ added: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("internalOwners")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .first();
    if (existing) return { added: false };
    await ctx.db.insert("internalOwners", {
      subject: args.subject,
      ...(args.note !== undefined ? { note: args.note } : {}),
      addedAt: Date.now(),
    });
    return { added: true };
  },
});

/**
 * Remove a subject from the internal-owner allowlist. Eligibility is recomputed
 * on every `nmlAuthority` read, so this takes effect immediately: a doc that was
 * eligible only through the allowlist becomes ineligible, and a migrated one
 * falls back to legacy authority with its NML root left in place and recoverable
 * — exactly as a cohort drop or `rollback`, and nothing is lost. That makes the
 * allowlist a real kill switch, not merely a stop on future migrations. Deletes
 * every row for the subject so a benign double-add leaves no lingering
 * membership. Internal, like `addInternalOwner`.
 */
export const removeInternalOwner = internalMutation({
  args: { subject: v.string() },
  returns: v.object({ removed: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("internalOwners")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});

/** Whether the app is cleared to serve NML at all — the master switch. */
async function serveEnabled(ctx: QueryCtx): Promise<boolean> {
  const row = await ctx.db.query("nmlServeState").first();
  return row?.enabled ?? false;
}

/**
 * The master serve switch, read by the editor to decide whether to attempt NML
 * at all. Reactive — flipping it with `setNmlServe` remounts open editors on the
 * next tick, which is what makes it an instant kill switch. Global and
 * content-free, so it needs no per-doc authorization. This is deliberately
 * separate from the per-doc `nmlAuthority`: this says "serving is on", that says
 * "this doc is individually migrated, verified, and in-cohort"; the editor (and,
 * later, MCP) require both.
 */
export const nmlServeEnabled = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => serveEnabled(ctx),
});

/**
 * Flip the master serve switch. Internal — an operator runs it via `convex run`,
 * the same class of control as `addInternalOwner`; it is the app-wide enable and
 * kill switch, never something an end user can touch. Idempotent upsert of the
 * single row.
 */
export const setNmlServe = internalMutation({
  args: { enabled: v.boolean() },
  returns: v.object({ enabled: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("nmlServeState").first();
    if (row) await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: Date.now() });
    else await ctx.db.insert("nmlServeState", { enabled: args.enabled, updatedAt: Date.now() });
    return { enabled: args.enabled };
  },
});

/** The current internal-owner allowlist. Internal — operator/ops visibility. */
export const listInternalOwners = internalQuery({
  args: {},
  returns: v.array(
    v.object({ subject: v.string(), note: v.optional(v.string()), addedAt: v.number() }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query("internalOwners").collect();
    return rows.map((r) => ({
      subject: r.subject,
      ...(r.note !== undefined ? { note: r.note } : {}),
      addedAt: r.addedAt,
    }));
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
    // Verify the persisted root server-side, independently of the claim above,
    // before any cohort is allowed to read it. Scheduled (not inline) so the
    // append commits regardless, and routed to a Node action because decoding a
    // document near the v1 size limits needs far more heap than a mutation
    // isolate has.
    await ctx.scheduler.runAfter(0, internal.nmlVerify.run, { docId: args.docId });
    return { elected: true, seq };
  },
});

/**
 * The bytes the Node verifier needs: the document's whole update history, read
 * cheaply in the isolate. Internal — only `nmlVerify.run` calls it. `too-large`
 * / `no-doc` are terminal denials the action records without decoding anything.
 */
export const verifyMaterial = internalQuery({
  args: { docId: v.string() },
  returns: v.union(
    v.object({ status: v.literal("ok"), updates: v.array(v.bytes()) }),
    v.object({ status: v.literal("too-large") }),
    v.object({ status: v.literal("no-doc") }),
  ),
  handler: async (ctx, args) => {
    const collected = await readStoredUpdates(ctx, args.docId);
    if (collected === null) return { status: "no-doc" as const };
    if ("tooLarge" in collected) return { status: "too-large" as const };
    return { status: "ok" as const, updates: collected.updates };
  },
});

/**
 * Record the Node verifier's verdict on the state row. Internal — only
 * `nmlVerify.run` calls it, after re-asserting the root independently of the
 * elected client's `equivalenceOk`/`limitOk` flags. Guards on status so a
 * rollback that raced ahead of the check is not overwritten, and is idempotent
 * so a re-verify simply refreshes the verdict.
 */
export const recordVerification = internalMutation({
  args: {
    docId: v.string(),
    ok: v.boolean(),
    reason: v.optional(v.string()),
    schemaVersion: v.optional(v.number()),
    encodingVersion: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await nmlStateRow(ctx, args.docId);
    if (!row || row.status !== "migrated") return null;
    await ctx.db.patch(row._id, {
      serverVerified: args.ok,
      serverVerifiedAt: Date.now(),
      ...(args.schemaVersion !== undefined ? { serverSchemaVersion: args.schemaVersion } : {}),
      ...(args.encodingVersion !== undefined ? { serverEncodingVersion: args.encodingVersion } : {}),
      ...(args.ok ? {} : { serverVerifyError: args.reason ?? "invalid" }),
    });
    return null;
  },
});

/**
 * The authority gate: whether NML is cleared to be the *served* tree for this
 * document. `serve` is true only when the document is migrated, in the cohort,
 * has passed the independent server verification, and declares versions this
 * deployment understands. Everything else — a pending or failed server check, a
 * rollback, a doc outside the cohort, or a newer root — keeps authority with
 * legacy (a newer root is read-only rather than downgrade-written). A cohort
 * client subscribes to this to decide which tree to read; nothing flips
 * authority on the elected migrator's word alone.
 */
export const nmlAuthority = query({
  args: { docId: v.string() },
  returns: v.object({
    serve: v.boolean(),
    reason: v.string(),
    schemaVersion: v.optional(v.number()),
    encodingVersion: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    const row = await nmlStateRow(ctx, args.docId);
    if (!row) return { serve: false, reason: "not-migrated" };
    if (row.status !== "migrated") return { serve: false, reason: "rolled-back" };
    if (!(await eligible(ctx, args.docId))) return { serve: false, reason: "not-in-cohort" };
    if (!row.serverVerified) {
      return { serve: false, reason: row.serverVerifyError ?? "pending-verification" };
    }
    if (
      row.serverSchemaVersion !== NML_SCHEMA_VERSION ||
      row.serverEncodingVersion !== NML_YJS_ENCODING_VERSION
    ) {
      return { serve: false, reason: "unsupported-version" };
    }
    return {
      serve: true,
      reason: "verified",
      schemaVersion: row.serverSchemaVersion,
      encodingVersion: row.serverEncodingVersion,
    };
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
      serverVerified: v.optional(v.boolean()),
      serverVerifiedAt: v.optional(v.number()),
      serverSchemaVersion: v.optional(v.number()),
      serverEncodingVersion: v.optional(v.number()),
      serverVerifyError: v.optional(v.string()),
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
      ...(row.serverVerified !== undefined ? { serverVerified: row.serverVerified } : {}),
      ...(row.serverVerifiedAt !== undefined ? { serverVerifiedAt: row.serverVerifiedAt } : {}),
      ...(row.serverSchemaVersion !== undefined ? { serverSchemaVersion: row.serverSchemaVersion } : {}),
      ...(row.serverEncodingVersion !== undefined ? { serverEncodingVersion: row.serverEncodingVersion } : {}),
      ...(row.serverVerifyError !== undefined ? { serverVerifyError: row.serverVerifyError } : {}),
      ...(row.rolledBackAt !== undefined ? { rolledBackAt: row.rolledBackAt } : {}),
      ...(row.rollbackReason !== undefined ? { rollbackReason: row.rollbackReason } : {}),
      ...(row.rolledBackDiverged !== undefined ? { rolledBackDiverged: row.rolledBackDiverged } : {}),
    };
  },
});

/**
 * Fleet health of the NML migration, for the Phase-2 dogfood soak: how many
 * documents migrated, how the independent server verification is going, and why
 * any failed. This is the queryable half of the soak signal ("migration success,
 * serverVerified pass rate") — the client-side signals (edit/conflict rate,
 * bridge drift, undo correctness, convergence) are watched through the editor
 * and existing logging, not here. Internal — an operator reads it via
 * `convex run`, like `listInternalOwners`.
 *
 * `serving` counts rows the deployment could serve (migrated, server-verified,
 * versions understood); it deliberately does NOT re-run the per-document cohort/
 * eligibility check, so a doc an operator has dropped from the cohort still
 * counts here — that is a health metric of the migrate→verify pipeline, not the
 * live serve gate (`nmlAuthority` remains the authority per doc).
 *
 * Cohort-scale: `nmlDocState` holds one row per migrated document and the
 * internal cohort is a handful of people, so a full scan is cheap. A far larger
 * cohort would want an index on `status` and pagination.
 */
export const nmlMigrationStats = internalQuery({
  args: {},
  returns: v.object({
    total: v.number(),
    migrated: v.number(),
    rolledBack: v.number(),
    verifyPending: v.number(),
    verifyPass: v.number(),
    verifyFail: v.number(),
    unsupportedVersion: v.number(),
    serving: v.number(),
    errorClasses: v.array(v.object({ reason: v.string(), count: v.number() })),
  }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("nmlDocState").collect();
    let migrated = 0;
    let rolledBack = 0;
    let verifyPending = 0;
    let verifyPass = 0;
    let verifyFail = 0;
    let unsupportedVersion = 0;
    let serving = 0;
    const errors = new Map<string, number>();
    for (const row of rows) {
      if (row.status === "rolledBack") {
        rolledBack++;
        continue;
      }
      migrated++;
      if (row.serverVerified === undefined) {
        verifyPending++;
        continue;
      }
      if (row.serverVerified === false) {
        verifyFail++;
        const reason = row.serverVerifyError ?? "invalid";
        errors.set(reason, (errors.get(reason) ?? 0) + 1);
        continue;
      }
      verifyPass++;
      if (
        row.serverSchemaVersion === NML_SCHEMA_VERSION &&
        row.serverEncodingVersion === NML_YJS_ENCODING_VERSION
      ) {
        serving++;
      } else {
        unsupportedVersion++;
      }
    }
    const errorClasses = [...errors.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
    return {
      total: rows.length,
      migrated,
      rolledBack,
      verifyPending,
      verifyPass,
      verifyFail,
      unsupportedVersion,
      serving,
      errorClasses,
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
