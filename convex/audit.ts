import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { atLeast, ownerId, readWorkspaceAs, workspaceRole } from "./auth";
import { entitlement } from "./entitlements";

/**
 * A workspace's audit log: who did what in it, and when.
 *
 * Discrete events — membership, sharing, integrations, deletes, billing,
 * operators — are written one row each by `record`, inside the mutation that
 * made the change, so a change that commits is a change that is logged and a
 * refused one leaves nothing. An action cannot do that, so it records through
 * `recordAsCaller` in its own mutation once the outside call has gone through.
 *
 * Editing is too frequent to log one row per flush, so `recordEdit` coalesces
 * it: one row per page, person and ten-minute window, counting the flushes it
 * stands for. That still answers what an auditor asks — who touched what,
 * and when — at about a thousandth of the rows.
 *
 * Only workspace changes are logged; a personal project writes nothing here.
 * `meta` carries ids, titles, roles and counts, never a document's text.
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
  actorId: string;
  actorKind?: ActorKind;
};

const EDIT = "page.edit";

/** The width of an edit-activity window. */
export const EDIT_WINDOW_MS = 10 * 60_000;
/** How long an event is kept. */
export const RETAIN_MS = 365 * 24 * 60 * 60_000;
/** Rows one sweep deletes before it hands the rest to another. */
const PRUNE_BATCH = 500;
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
function categoryOf(action: string): string {
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
  if (actorId) {
    await record(ctx, { ...event, meta, workspaceId: project.workspaceId, actorId });
  } else {
    await recordByCaller(ctx, project.workspaceId, { ...event, meta });
  }
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
    actorId,
    pageId: page._id,
    at: Date.now(),
    meta: { projectId: project._id, project: project.title, page: page.title },
  });
}

/**
 * The retention sweep: events past a year, oldest first, a batch at a time.
 * A full batch hands the rest to another run at once, so no one run carries
 * a year's backlog.
 */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("auditEvents")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - RETAIN_MS))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === PRUNE_BATCH) await ctx.scheduler.runAfter(0, internal.audit.prune, {});
    return null;
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
      meta: row.meta ?? {},
      count: row.count ?? null,
    })),
  );
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
