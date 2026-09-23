import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mayReadAudit } from "./auth";
import { auditMeta } from "./schema";

/**
 * The one writer of `auditEvents`. A helper rather than a mutation: an event
 * is recorded by the mutation that did the thing, inside its transaction, so
 * the record and the act land or fail together and no client can forge one.
 *
 * The shape is enforced here, not merely typed: an action is a dotted verb, and
 * every id is id-shaped — no spaces, bounded — so a comment body cannot ride
 * into the log through a field named like an identifier. What the log answers
 * is who touched what, and when; never what they said.
 */

export type AuditMeta = Infer<typeof auditMeta>;

export type AuditEvent = {
  projectId?: Id<"projects">;
  workspaceId?: string;
  actorId: string;
  actorKind: Doc<"auditEvents">["actorKind"];
  action: string;
  subjectKind?: string;
  subjectId?: string;
  meta?: AuditMeta;
};

const ACTION = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/;
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const KEY = /^[a-z][a-zA-Z0-9]{0,31}$/;

/**
 * Keys that name words rather than things. The id rule already refuses
 * anything with a space in it, which leaves a one-word body ("LGTM") that is
 * id-shaped — so the field it would ride in on is refused by name as well.
 */
const CONTENT_KEY = /^(body|text|content|quote|exact|prefix|suffix|message|html|markdown|excerpt|snippet)$/i;
/** Meta is a handful of references, never a list somebody could pour a document into. */
const MAX_META_ENTRIES = 16;

/** Whether a value may stand in the log as an identifier. */
export function isAuditId(value: string): boolean {
  return ID.test(value);
}

function assertId(value: string, what: string): void {
  if (!isAuditId(value)) throw new Error(`Audit ${what} is not an identifier.`);
}

function assertKeys(entries: Record<string, unknown>): void {
  const keys = Object.keys(entries);
  if (keys.length > MAX_META_ENTRIES) throw new Error("Audit meta carries too many entries.");
  for (const key of keys) {
    if (!KEY.test(key)) throw new Error("Audit meta key is not a name.");
    if (CONTENT_KEY.test(key)) throw new Error(`Audit meta key "${key}" names content, not a thing.`);
  }
}

export async function recordAudit(
  ctx: MutationCtx,
  event: AuditEvent,
): Promise<Id<"auditEvents">> {
  if (!ACTION.test(event.action)) throw new Error("Audit action is not a dotted verb.");
  assertId(event.actorId, "actor");
  if (event.workspaceId !== undefined) assertId(event.workspaceId, "workspace");
  if (event.subjectKind !== undefined && !KEY.test(event.subjectKind)) {
    throw new Error("Audit subject kind is not a name.");
  }
  if (event.subjectId !== undefined) assertId(event.subjectId, "subject");
  const ids = event.meta?.ids ?? {};
  const counts = event.meta?.counts ?? {};
  assertKeys(ids);
  assertKeys(counts);
  for (const [key, value] of Object.entries(ids)) assertId(value, `meta id "${key}"`);
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isFinite(value)) throw new Error(`Audit meta count "${key}" is not a number.`);
  }
  return await ctx.db.insert("auditEvents", { ...event, at: Date.now() });
}

/**
 * One row of a project's log as its owner reads it: the stored event, with the
 * two references a person needs to read it — who, and which page — resolved to
 * a name and a title. Titles are allowed (the Teams design's "ids, titles and
 * counts only"); what anyone wrote never is, and nothing here could carry it.
 */
export const auditRow = v.object({
  id: v.id("auditEvents"),
  at: v.number(),
  action: v.string(),
  actorId: v.string(),
  actorKind: v.union(v.literal("user"), v.literal("operator"), v.literal("system")),
  /** A user actor's profile name (or email), when their profile has one. */
  actorName: v.union(v.string(), v.null()),
  subjectKind: v.union(v.string(), v.null()),
  subjectId: v.union(v.string(), v.null()),
  pageId: v.union(v.id("pages"), v.null()),
  pageTitle: v.union(v.string(), v.null()),
  meta: v.union(auditMeta, v.null()),
  count: v.union(v.number(), v.null()),
});

export type AuditRow = Infer<typeof auditRow>;

/**
 * The page an event is about, if it names one: `meta.ids.pageId`, or the
 * subject itself when the subject is a page. Only a page of THIS project
 * resolves — an id that happens to name somebody else's page reads as
 * nothing, so the log cannot be used to learn a stranger's page title.
 */
function pageOf(
  ctx: QueryCtx,
  project: Doc<"projects">,
  event: Doc<"auditEvents">,
  cache: Map<string, Promise<Doc<"pages"> | null>>,
): Promise<Doc<"pages"> | null> {
  const raw = event.meta?.ids?.pageId ?? (event.subjectKind === "page" ? event.subjectId : undefined);
  if (!raw) return Promise.resolve(null);
  let found = cache.get(raw);
  if (!found) {
    const id = ctx.db.normalizeId("pages", raw);
    found = (id ? ctx.db.get(id) : Promise.resolve(null)).then((page) =>
      page && page.projectId === project._id ? page : null,
    );
    cache.set(raw, found);
  }
  return found;
}

function actorNameOf(
  ctx: QueryCtx,
  event: Doc<"auditEvents">,
  cache: Map<string, Promise<string | null>>,
): Promise<string | null> {
  if (event.actorKind !== "user") return Promise.resolve(null);
  let name = cache.get(event.actorId);
  if (!name) {
    name = ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", event.actorId))
      .unique()
      .then((profile) => profile?.name?.trim() || profile?.email || null);
    cache.set(event.actorId, name);
  }
  return name;
}

/** The most rows one page answers with, whatever the client asks for. */
const MAX_PAGE = 200;

/**
 * A project's audit log, oldest first, one page at a time — what the owner's
 * CSV export walks. `from` is inclusive and `to` exclusive, both epoch ms, so
 * consecutive periods tile without a row landing in two.
 *
 * Refused as "Not found" to anyone `auth.mayReadAudit` does not admit, so a
 * stranger cannot tell a project with a log from one without.
 */
export const forProject = query({
  args: {
    projectId: v.id("projects"),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(auditRow),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project || !(await mayReadAudit(ctx, project))) throw new Error("Not found");

    const { from, to } = args;
    const result = await ctx.db
      .query("auditEvents")
      .withIndex("by_project_at", (q) => {
        const scoped = q.eq("projectId", project._id);
        if (from !== undefined && to !== undefined) return scoped.gte("at", from).lt("at", to);
        if (from !== undefined) return scoped.gte("at", from);
        if (to !== undefined) return scoped.lt("at", to);
        return scoped;
      })
      .order("asc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE),
      });

    const pages = new Map<string, Promise<Doc<"pages"> | null>>();
    const names = new Map<string, Promise<string | null>>();
    const rows = await Promise.all(
      result.page.map(async (event): Promise<AuditRow> => {
        const [target, actorName] = await Promise.all([
          pageOf(ctx, project, event, pages),
          actorNameOf(ctx, event, names),
        ]);
        return {
          id: event._id,
          at: event.at,
          action: event.action,
          actorId: event.actorId,
          actorKind: event.actorKind,
          actorName,
          subjectKind: event.subjectKind ?? null,
          subjectId: event.subjectId ?? null,
          pageId: target?._id ?? null,
          pageTitle: target ? target.title || "Untitled" : null,
          meta: event.meta ?? null,
          count: event.count ?? null,
        };
      }),
    );
    return { ...result, page: rows };
  },
});

/** How long an event is kept: a year, the Teams design's retention. */
export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** Rows deleted per sweep transaction — well inside a mutation's write limits. */
export const SWEEP_BATCH = 500;

/**
 * Deletes events past retention, oldest first, a bounded batch at a time. A
 * full batch means there may be more, so the sweep schedules itself again at
 * once rather than waiting a day: a backlog drains within one run of the cron,
 * and each transaction stays small.
 */
export const sweepExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const expired = await ctx.db
      .query("auditEvents")
      .withIndex("by_at", (q) => q.lt("at", cutoff))
      .take(SWEEP_BATCH);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.audit.sweepExpired, {});
    }
    return expired.length;
  },
});
