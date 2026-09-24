import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { atLeast, mayReadAudit, ownerId, readWorkspaceAs, workspaceRole } from "./auth";
import { entitlement } from "./entitlements";
import { auditMeta } from "./schema";

/**
 * The audit log: who did what, and when. One table, two ways in.
 *
 * A workspace's log (`list`, `exportRows`) holds everything done in it —
 * membership, sharing, integrations, deletes, billing, operators, editing,
 * and comments on its projects — read by its admins and owners on a plan that
 * includes it. A project's log (`forProject`) is the slice about one project,
 * what its owner's CSV export walks; for a personal project, which has no
 * workspace, it is the only log there is.
 *
 * Discrete events are written one row each, inside the mutation that made the
 * change, so a change that commits is a change that is logged and a refused
 * one leaves nothing. An action cannot do that, so it records through
 * `recordAsCaller` in its own mutation once the outside call has gone through.
 *
 * Editing is too frequent to log one row per flush, so `recordEdit` coalesces
 * it: one row per page, person and ten-minute window, counting the flushes it
 * stands for. That still answers what an auditor asks — who touched what,
 * and when — at about a thousandth of the rows.
 *
 * `meta` carries ids, titles, roles and counts, never a document's or a
 * comment's text. Two shapes stand in it: the workspace writers' flat map of
 * scalars (`record`), and the comment writers' `{ids, counts}` (`recordAudit`),
 * which checks every value is id-shaped because what it sits beside is a
 * conversation.
 */

export type AuditMeta = Record<string, string | number | boolean | null | undefined>;
export type ActorKind = Doc<"auditEvents">["actorKind"];

/** What happened, before it is known who did it or where. */
export type AuditAction = {
  action: string;
  subjectKind?: string;
  subjectId?: string;
  meta?: AuditMeta;
};

export type AuditEvent = AuditAction & {
  workspaceId: Id<"workspaces">;
  /** The project it happened in, so the project's own log shows it too. */
  projectId?: Id<"projects">;
  actorId: string;
  actorKind?: ActorKind;
};

const EDIT = "page.edit";

/** The width of an edit-activity window. */
export const EDIT_WINDOW_MS = 10 * 60_000;
/** Rows one page of an export carries. */
const EXPORT_PAGE = 500;

/** Kinds an admin looks for as one: what connects a project outside, and what it costs. */
const GROUPS: Record<string, string> = {
  repo: "integration",
  github: "integration",
  notion: "integration",
  entitlement: "billing",
};

/**
 * The index range an action is read through: its first segment, grouped as
 * the log's filter offers it, except that edits are a kind of their own, so
 * "Pages" is not buried under them.
 */
export function categoryOf(action: string): string {
  if (action === EDIT || action.startsWith(`${EDIT}.`)) return "edit";
  const head = action.split(".")[0];
  return GROUPS[head] ?? head;
}

/** `undefined` dropped: a field that says nothing is left out rather than stored. */
function cleanMeta(meta: AuditMeta | undefined): Doc<"auditEvents">["meta"] {
  if (!meta) return undefined;
  const kept = Object.entries(meta).filter(
    (entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined,
  );
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Writes one discrete event. Call it in the same mutation as the change. */
export async function record(ctx: MutationCtx, event: AuditEvent): Promise<void> {
  await ctx.db.insert("auditEvents", {
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    actorId: event.actorId,
    actorKind: event.actorKind ?? "user",
    action: event.action,
    category: categoryOf(event.action),
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
    meta: cleanMeta(event.meta),
    at: Date.now(),
  });
}

/**
 * {@link record} for whoever is signed in — every public write, since those
 * refuse an operator's stand-in before they get this far.
 */
export async function recordByCaller(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  event: AuditAction,
): Promise<void> {
  const actorId = await ownerId(ctx);
  if (!actorId) throw new Error("Not signed in");
  await record(ctx, { ...event, workspaceId, actorId });
}

/**
 * {@link record} for a change inside a project: nothing for a personal one,
 * and for a workspace's, the project named in `meta` beside whatever the
 * event says. `actorId` defaults to the caller.
 */
export async function recordInProject(
  ctx: MutationCtx,
  project: Doc<"projects">,
  event: AuditAction,
  actorId?: string,
): Promise<void> {
  if (!project.workspaceId) return;
  const meta = { projectId: project._id, project: project.title, ...event.meta };
  const actor = actorId ?? (await ownerId(ctx));
  if (!actor) throw new Error("Not signed in");
  await record(ctx, {
    ...event,
    meta,
    workspaceId: project.workspaceId,
    projectId: project._id,
    actorId: actor,
  });
}

/** An action's {@link recordByCaller}, run once its outside call has gone through. */
export const recordAsCaller = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    action: v.string(),
    subjectKind: v.optional(v.string()),
    subjectId: v.optional(v.string()),
    meta: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, ...event }) => {
    await recordByCaller(ctx, workspaceId, event);
    return null;
  },
});

/**
 * One edit, folded into its window's row: the first edit in a window writes
 * the row, and every later one counts on it. The key is the page, the person
 * and the window, so two people editing one page keep separate rows.
 */
export async function recordEdit(
  ctx: MutationCtx,
  edit: {
    workspaceId: Id<"workspaces">;
    projectId?: Id<"projects">;
    actorId: string;
    pageId: Id<"pages">;
    at: number;
    meta?: AuditMeta;
  },
): Promise<void> {
  const windowKey = `${edit.pageId}:${edit.actorId}:${Math.floor(edit.at / EDIT_WINDOW_MS)}`;
  const row = await ctx.db
    .query("auditEvents")
    .withIndex("by_window", (q) => q.eq("windowKey", windowKey))
    .unique();
  if (row) {
    await ctx.db.patch(row._id, { count: (row.count ?? 1) + 1 });
    return;
  }
  await ctx.db.insert("auditEvents", {
    workspaceId: edit.workspaceId,
    projectId: edit.projectId,
    actorId: edit.actorId,
    actorKind: "user",
    action: EDIT,
    category: categoryOf(EDIT),
    subjectKind: "page",
    subjectId: edit.pageId,
    meta: cleanMeta(edit.meta),
    at: edit.at,
    windowKey,
    count: 1,
  });
}

/**
 * {@link recordEdit} for a write to a document, by the caller, once the write
 * gate has let it through. Nothing for a personal project's page.
 */
export async function recordDocumentEdit(ctx: MutationCtx, docId: string): Promise<void> {
  const page = await ctx.db
    .query("pages")
    .withIndex("by_doc", (q) => q.eq("docId", docId))
    .unique();
  const project = page && (await ctx.db.get(page.projectId));
  const actorId = await ownerId(ctx);
  if (!page || !project?.workspaceId || !actorId) return;
  await recordEdit(ctx, {
    workspaceId: project.workspaceId,
    projectId: project._id,
    actorId,
    pageId: page._id,
    at: Date.now(),
    meta: { projectId: project._id, project: project.title, page: page.title },
  });
}


/** `recordAudit`'s meta: references and counts, nothing a person wrote. */
export type IdMeta = Infer<typeof auditMeta>;

/**
 * An event `recordAudit` checks before it writes. Its workspace is never the
 * caller's to name: it is read off the project, so an event in a workspace
 * project lands in that workspace's log as well as the project's.
 */
export type CheckedAuditEvent = {
  projectId?: Id<"projects">;
  actorId: string;
  actorKind: ActorKind;
  action: string;
  subjectKind?: string;
  subjectId?: string;
  meta?: IdMeta;
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

/**
 * The checked writer, for events that sit beside what people wrote — the
 * comment events, and a project's feature overrides. The shape is enforced
 * here, not merely typed: an action is a dotted verb, and every id is
 * id-shaped — no spaces, bounded — so a comment body cannot ride into the log
 * through a field named like an identifier. What the log answers is who
 * touched what, and when; never what they said.
 */
export async function recordAudit(
  ctx: MutationCtx,
  event: CheckedAuditEvent,
): Promise<Id<"auditEvents">> {
  if (!ACTION.test(event.action)) throw new Error("Audit action is not a dotted verb.");
  assertId(event.actorId, "actor");
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
  const project = event.projectId && (await ctx.db.get(event.projectId));
  return await ctx.db.insert("auditEvents", {
    ...event,
    workspaceId: project ? project.workspaceId : undefined,
    category: categoryOf(event.action),
    at: Date.now(),
  });
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
  /** Its references and counts; a workspace event's flat map is read as the same. */
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
type StoredMeta = NonNullable<Doc<"auditEvents">["meta"]>;

function isIdMeta(meta: StoredMeta): meta is IdMeta {
  return Object.values(meta).every((value) => value !== null && typeof value === "object");
}

/**
 * Either writer's meta as `{ids, counts}`: a flat map's id-shaped strings as
 * ids and its numbers as counts. Its words — titles, names, notes — are the
 * workspace log's to show, not a project export's.
 */
function asIdMeta(meta: StoredMeta): IdMeta {
  if (isIdMeta(meta)) return meta;
  const ids: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string" && isAuditId(value)) ids[key] = value;
    else if (typeof value === "number") counts[key] = value;
  }
  return { ids, counts };
}

/** Either writer's meta as one flat map, the way the workspace log reads it. */
function asFlatMeta(meta: StoredMeta | undefined): Record<string, string | number | boolean | null> {
  if (!meta) return {};
  return isIdMeta(meta) ? { ...meta.ids, ...meta.counts } : meta;
}

/** The page an event's meta names, in whichever shape it was written. */
function pageIdIn(meta: Doc<"auditEvents">["meta"]): string | undefined {
  return meta ? asIdMeta(meta).ids?.pageId : undefined;
}

function pageOf(
  ctx: QueryCtx,
  project: Doc<"projects">,
  event: Doc<"auditEvents">,
  cache: Map<string, Promise<Doc<"pages"> | null>>,
): Promise<Doc<"pages"> | null> {
  const raw = pageIdIn(event.meta) ?? (event.subjectKind === "page" ? event.subjectId : undefined);
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
          meta: event.meta ? asIdMeta(event.meta) : null,
          count: event.count ?? null,
        };
      }),
    );
    return { ...result, page: rows };
  },
});

/** How long an event is kept: a year. */
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

// ---- Reading ---------------------------------------------------------------

/**
 * The gate for reading a workspace's log: an admin or its owner, and a plan
 * that includes it. The log is written whatever the plan, so buying one shows
 * the history from before.
 */
async function requireLogReader(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  await readWorkspaceAs(ctx, workspaceId, "admin");
  if (!(await entitlement(ctx, { kind: "workspace", workspaceId }, "auditLog"))) {
    throw new ConvexError("The audit log comes with the Team plan.");
  }
}

/**
 * Whether the caller may open the log, for the settings screen to ask before
 * it does: null for anyone short of admin, and whether the plan includes it
 * otherwise.
 */
export const access = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    if (!atLeast(await workspaceRole(ctx, args.workspaceId), "admin")) return null;
    return {
      included: await entitlement(
        ctx,
        { kind: "workspace", workspaceId: args.workspaceId },
        "auditLog",
      ),
    };
  },
});

async function personOf(ctx: QueryCtx, userId: string) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .unique();
  return profile
    ? {
        name: profile.name ?? null,
        email: profile.email ?? null,
        imageUrl: profile.imageUrl ?? null,
      }
    : null;
}

/** Events as the screen and the export draw them: each person named once per page. */
async function present(ctx: QueryCtx, rows: Doc<"auditEvents">[]) {
  const people = new Map<string, Awaited<ReturnType<typeof personOf>>>();
  const person = async (userId: string) => {
    if (!people.has(userId)) people.set(userId, await personOf(ctx, userId));
    return people.get(userId)!;
  };
  const projects = new Map<string, Promise<Doc<"projects"> | null>>();
  const pages = new Map<string, Promise<Doc<"pages"> | null>>();
  return await Promise.all(
    rows.map(async (row) => ({
      _id: row._id,
      at: row.at,
      action: row.action,
      actorId: row.actorId,
      actorKind: row.actorKind,
      actor: row.actorKind === "user" ? await person(row.actorId) : null,
      subjectKind: row.subjectKind ?? null,
      subjectId: row.subjectId ?? null,
      subject:
        row.subjectKind === "user" && row.subjectId ? await person(row.subjectId) : null,
      meta: await namedMeta(ctx, row, projects, pages),
      count: row.count ?? null,
    })),
  );
}

/**
 * A row's meta as the workspace log reads it: one flat map, and for an event
 * the checked writer recorded — which stores ids, never names — the project
 * and page it names, by their titles now. Only a project of the row's own
 * workspace, and a page of that project, is named, so an id cannot be used to
 * read a title from elsewhere.
 */
async function namedMeta(
  ctx: QueryCtx,
  row: Doc<"auditEvents">,
  projects: Map<string, Promise<Doc<"projects"> | null>>,
  pages: Map<string, Promise<Doc<"pages"> | null>>,
): Promise<Record<string, string | number | boolean | null>> {
  const meta = asFlatMeta(row.meta);
  if (!row.projectId || !row.meta || !isIdMeta(row.meta)) return meta;
  const { projectId } = row;
  let found = projects.get(projectId);
  if (!found) {
    found = ctx.db.get(projectId).then((p) => (p && p.workspaceId === row.workspaceId ? p : null));
    projects.set(projectId, found);
  }
  const project = await found;
  if (!project) return meta;
  const named: Record<string, string | number | boolean | null> = {
    ...meta,
    projectId: project._id,
    project: project.title,
  };
  const pageId = typeof meta.pageId === "string" ? ctx.db.normalizeId("pages", meta.pageId) : null;
  if (pageId) {
    let page = pages.get(pageId);
    if (!page) {
      page = ctx.db.get(pageId).then((p) => (p && p.projectId === project._id ? p : null));
      pages.set(pageId, page);
    }
    const title = (await page)?.title;
    if (title !== undefined) named.page = title || "Untitled";
  }
  return named;
}

const filters = v.object({
  actorId: v.optional(v.string()),
  /** "member" for every membership event, "member.invite" for invitations alone. */
  action: v.optional(v.string()),
  /** Inclusive, in ms. */
  from: v.optional(v.number()),
  /** Exclusive, in ms. */
  to: v.optional(v.number()),
});

/**
 * The events that match, newest or oldest first, by the narrowest index the
 * filters allow: the person's kind of event, the person's, the kind of
 * event's, else the whole log. Only an action longer than its kind is left
 * to a filter, and that reads rows already of its kind.
 */
export function matching(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  f: { actorId?: string; action?: string; from?: number; to?: number },
  order: "asc" | "desc",
) {
  const from = f.from ?? 0;
  const to = f.to ?? Number.MAX_SAFE_INTEGER;
  const action = f.action?.trim() || undefined;
  const category = action && categoryOf(action);
  const { actorId } = f;
  const events = ctx.db.query("auditEvents");
  const ranged =
    actorId !== undefined && category
      ? events.withIndex("by_workspace_actor_category_at", (q) =>
          q
            .eq("workspaceId", workspaceId)
            .eq("actorId", actorId)
            .eq("category", category)
            .gte("at", from)
            .lt("at", to),
        )
      : actorId !== undefined
        ? events.withIndex("by_workspace_actor_at", (q) =>
            q.eq("workspaceId", workspaceId).eq("actorId", actorId).gte("at", from).lt("at", to),
          )
        : category
          ? events.withIndex("by_workspace_category_at", (q) =>
              q.eq("workspaceId", workspaceId).eq("category", category).gte("at", from).lt("at", to),
            )
          : events.withIndex("by_workspace_at", (q) =>
              q.eq("workspaceId", workspaceId).gte("at", from).lt("at", to),
            );
  const ordered = ranged.order(order);
  if (!action || action === category) return ordered;
  return ordered.filter((q) =>
    q.and(q.gte(q.field("action"), action), q.lt(q.field("action"), `${action}\uffff`)),
  );
}

/** The log, newest first, a page at a time. Admins and owners. */
export const list = query({
  args: {
    workspaceId: v.id("workspaces"),
    paginationOpts: paginationOptsValidator,
    filters: v.optional(filters),
  },
  handler: async (ctx, args) => {
    await requireLogReader(ctx, args.workspaceId);
    const result = await matching(ctx, args.workspaceId, args.filters ?? {}, "desc").paginate(
      args.paginationOpts,
    );
    return { ...result, page: await present(ctx, result.page) };
  },
});

/**
 * A period of the log, oldest first, for a CSV file: a page per call, the
 * client asking again with `cursor` until `done`. Narrowed by the same
 * filters as `list`, through the same index, so an export of one person
 * reads that person's rows and no one else's. Admins and owners.
 */
export const exportRows = query({
  args: {
    workspaceId: v.id("workspaces"),
    from: v.number(),
    to: v.number(),
    filters: v.optional(v.object({ actorId: v.optional(v.string()), action: v.optional(v.string()) })),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    await requireLogReader(ctx, args.workspaceId);
    const result = await matching(
      ctx,
      args.workspaceId,
      { ...args.filters, from: args.from, to: args.to },
      "asc",
    ).paginate({ cursor: args.cursor, numItems: EXPORT_PAGE });
    return {
      rows: await present(ctx, result.page),
      cursor: result.continueCursor,
      done: result.isDone,
    };
  },
});
