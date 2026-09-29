import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { agentOwnsPage, agentProjects, ownerId, requireOwner } from "../auth";
import { recordAudit } from "../audit";
import { serveEnabled, servedAuthority } from "../nmlMigration";
import { pageForDoc } from "../prosemirror";
import { appendYUpdate, readStoredUpdates } from "../ydoc";
import { grantMayWrite } from "./oauth";

/**
 * Which documents an MCP agent can see, and the bytes of one it may read.
 *
 * The rule the whole MCP design rests on: an agent only ever sees a document
 * whose canonical NML root is served — migrated, independently verified, in the
 * cohort, with the master serve switch on. A legacy document is not refused
 * after being found; it is never listed, and reading one by id answers the same
 * as an id that does not exist. Ownership is `auth.agentOwnsPage`'s, asked
 * first, so a document that is not the agent's principal's says nothing about
 * whether it is served.
 *
 * These run in the isolate and hand raw bytes to `mcp/read.ts`, which decodes in
 * Node for the heap a large document needs — the `nmlVerify` split.
 */

const PROJECTS = 100;
const PAGES = 1000;

export const docSummary = v.object({
  docId: v.string(),
  pageId: v.id("pages"),
  projectId: v.id("projects"),
  title: v.string(),
  projectTitle: v.string(),
  updatedAt: v.number(),
});

async function servable(ctx: QueryCtx, subject: string, page: Doc<"pages">) {
  const project = await agentOwnsPage(ctx, subject, page);
  if (!project) return { project: null, served: false };
  return { project, served: (await servedAuthority(ctx, page.docId)).serve };
}

const summarize = (page: Doc<"pages">, project: Doc<"projects">) => ({
  docId: page.docId,
  pageId: page._id,
  projectId: project._id,
  title: page.title,
  projectTitle: project.title,
  updatedAt: page.updatedAt ?? page.createdAt,
});

/** Every served document the subject owns, most recently edited first. */
export const servedDocs = internalQuery({
  args: { subject: v.string() },
  returns: v.array(docSummary),
  handler: async (ctx, args) => {
    if (!(await serveEnabled(ctx))) return [];
    const docs = [];
    let pagesRead = 0;
    for (const project of await agentProjects(ctx, args.subject, PROJECTS)) {
      for await (const page of ctx.db.query("pages").withIndex("by_project", (q) => q.eq("projectId", project._id))) {
        if (++pagesRead > PAGES) break;
        const { project: owned, served } = await servable(ctx, args.subject, page);
        if (owned && served) docs.push(summarize(page, owned));
      }
      if (pagesRead > PAGES) break;
    }
    return docs.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

/**
 * A reference as a person or model might give one: a docId, a page id, or a
 * Nootles page URL (`/p/<projectId>?page=<pageId>`).
 */
export async function pageFor(ctx: QueryCtx, ref: string): Promise<Doc<"pages"> | null> {
  const trimmed = ref.trim();
  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    candidate = url.searchParams.get("page") ?? candidate;
  } catch {
    // Not a URL: an id.
  }
  const pageId = ctx.db.normalizeId("pages", candidate);
  if (pageId) return await ctx.db.get(pageId);
  return await pageForDoc(ctx, candidate);
}

export const material = v.union(
  v.object({
    status: v.literal("ok"),
    doc: docSummary,
    updates: v.array(v.bytes()),
    /** The log position the updates were read at: an edit commits only if it still is. */
    seq: v.number(),
  }),
  v.object({
    status: v.literal("refused"),
    reason: v.union(v.literal("not-found"), v.literal("not-served"), v.literal("too-large")),
    detail: v.optional(v.string()),
  }),
);

export const readMaterial = internalQuery({
  args: { subject: v.string(), ref: v.string() },
  returns: material,
  handler: async (ctx, args) => {
    const page = await pageFor(ctx, args.ref);
    if (!page) return { status: "refused" as const, reason: "not-found" as const };
    const project = await agentOwnsPage(ctx, args.subject, page);
    if (!project) return { status: "refused" as const, reason: "not-found" as const };
    if (!(await serveEnabled(ctx))) {
      return { status: "refused" as const, reason: "not-served" as const, detail: "serving-off" };
    }
    const authority = await servedAuthority(ctx, page.docId);
    if (!authority.serve) {
      return { status: "refused" as const, reason: "not-served" as const, detail: authority.reason };
    }
    const stored = await readStoredUpdates(ctx, page.docId);
    if (!stored) return { status: "refused" as const, reason: "not-found" as const };
    if ("tooLarge" in stored) return { status: "refused" as const, reason: "too-large" as const };
    return { status: "ok" as const, doc: summarize(page, project), updates: stored.updates, seq: stored.seq };
  },
});

/**
 * The owner's project log gets one line per document an agent read: which page,
 * through which connection, and how many blocks — never what they said.
 */
export const recordRead = internalMutation({
  args: {
    subject: v.string(),
    grantId: v.id("mcpGrants"),
    pageId: v.id("pages"),
    projectId: v.id("projects"),
    blocks: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      actorId: args.subject,
      actorKind: "user",
      action: "mcp.read",
      projectId: args.projectId,
      subjectKind: "page",
      subjectId: args.pageId,
      meta: { ids: { grant: args.grantId }, counts: { blocks: args.blocks } },
    });
    return null;
  },
});

// ---- Edits (NT-123) -------------------------------------------------------------

/** How long an agent's edit stays undoable; its inverse is deleted after. */
export const EDIT_UNDO_DAYS = 7;
const UNDO_MS = EDIT_UNDO_DAYS * 24 * 60 * 60 * 1000;

const counts = v.object({ added: v.number(), changed: v.number(), removed: v.number(), moved: v.number() });
const touched = v.array(v.object({ id: v.string(), before: v.union(v.string(), v.null()), after: v.union(v.string(), v.null()) }));

/** Why a write did not land, when the document or the grant is the reason. */
const writeRefusal = v.union(
  v.literal("not-found"),
  v.literal("not-served"),
  v.literal("no-write"),
);

/**
 * Everything a write re-checks inside the transaction that writes: the grant,
 * the page's owner, and that it is still served — the predicate that keeps an
 * agent off the legacy root, asked again at the last moment.
 */
async function writable(
  ctx: QueryCtx,
  args: { subject: string; grantId?: Id<"mcpGrants">; docId: string },
): Promise<{ page: Doc<"pages">; project: Doc<"projects"> } | "not-found" | "not-served" | "no-write"> {
  if (args.grantId && !(await grantMayWrite(ctx, args.grantId, args.subject))) return "no-write";
  const page = await pageForDoc(ctx, args.docId);
  const project = page && (await agentOwnsPage(ctx, args.subject, page));
  if (!page || !project) return "not-found";
  if (!(await serveEnabled(ctx)) || !(await servedAuthority(ctx, args.docId)).serve) return "not-served";
  return { page, project };
}

/** A retried call with the same key: the edit it already made, if any. */
export const priorEdit = internalQuery({
  args: { subject: v.string(), idempotencyKey: v.string() },
  returns: v.union(v.null(), v.object({ editId: v.id("mcpEdits"), opsHash: v.string(), docId: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("mcpEdits")
      .withIndex("by_subject_and_key", (q) => q.eq("subject", args.subject).eq("idempotencyKey", args.idempotencyKey))
      .first();
    return row ? { editId: row._id, opsHash: row.opsHash, docId: row.docId } : null;
  },
});

async function append(ctx: MutationCtx, docId: string, seq: number, chunks: ArrayBuffer[]): Promise<boolean> {
  const row = await ctx.db
    .query("ydocs")
    .withIndex("by_doc", (q) => q.eq("docId", docId))
    .unique();
  // Anyone else's append since the read means the edit was computed against a
  // page that no longer exists; the action rebuilds and tries again.
  if (!row || row.seq !== seq) return false;
  await appendYUpdate(ctx, docId, chunks);
  return true;
}

/**
 * Lands an edit the action computed: the update appended at exactly the seq it
 * was computed against, the edit's record, and one content-free audit line —
 * all or nothing.
 */
export const commitEdit = internalMutation({
  args: {
    subject: v.string(),
    grantId: v.id("mcpGrants"),
    clientName: v.string(),
    docId: v.string(),
    seq: v.number(),
    chunks: v.array(v.bytes()),
    inverse: v.id("_storage"),
    batchId: v.string(),
    idempotencyKey: v.string(),
    opsHash: v.string(),
    counts,
    changedIds: v.array(v.string()),
    touched,
  },
  returns: v.union(
    v.object({ status: v.literal("ok"), editId: v.id("mcpEdits") }),
    v.object({ status: v.literal("stale") }),
    v.object({ status: v.literal("refused"), reason: writeRefusal }),
  ),
  handler: async (ctx, args) => {
    const target = await writable(ctx, args);
    if (typeof target === "string") return { status: "refused" as const, reason: target };
    if (!(await append(ctx, args.docId, args.seq, args.chunks))) return { status: "stale" as const };
    const editId = await ctx.db.insert("mcpEdits", {
      subject: args.subject,
      grantId: args.grantId,
      clientName: args.clientName,
      docId: args.docId,
      pageId: target.page._id,
      projectId: target.project._id,
      batchId: args.batchId,
      idempotencyKey: args.idempotencyKey,
      opsHash: args.opsHash,
      counts: args.counts,
      changedIds: args.changedIds.slice(0, 200),
      touched: args.touched,
      inverse: args.inverse,
      createdAt: Date.now(),
    });
    await recordAudit(ctx, {
      actorId: args.subject,
      actorKind: "user",
      action: "mcp.edit",
      projectId: target.project._id,
      subjectKind: "page",
      subjectId: target.page._id,
      meta: { ids: { grant: args.grantId, edit: editId }, counts: args.counts },
    });
    return { status: "ok" as const, editId };
  },
});

const undoable = v.object({
  status: v.literal("ok"),
  editId: v.id("mcpEdits"),
  docId: v.string(),
  pageId: v.id("pages"),
  projectId: v.id("projects"),
  title: v.string(),
  inverse: v.id("_storage"),
  touched,
  updates: v.array(v.bytes()),
  seq: v.number(),
});

/** An edit to undo, with the page as it stands, for `mcp/edit.undoEdit`. */
export const undoMaterial = internalQuery({
  /** A string: an agent names the edit from a tool result, and may name it wrong. */
  args: { subject: v.string(), editId: v.string(), grantId: v.optional(v.id("mcpGrants")) },
  returns: v.union(
    undoable,
    v.object({
      status: v.literal("refused"),
      reason: v.union(writeRefusal, v.literal("already-undone"), v.literal("expired"), v.literal("too-large")),
    }),
  ),
  handler: async (ctx, args) => {
    const editId = ctx.db.normalizeId("mcpEdits", args.editId);
    const edit = editId && (await ctx.db.get(editId));
    if (!edit || edit.subject !== args.subject) return { status: "refused" as const, reason: "not-found" as const };
    if (edit.undoneAt !== undefined) return { status: "refused" as const, reason: "already-undone" as const };
    if (!edit.inverse) return { status: "refused" as const, reason: "expired" as const };
    const target = await writable(ctx, { subject: args.subject, grantId: args.grantId, docId: edit.docId });
    if (typeof target === "string") return { status: "refused" as const, reason: target };
    const stored = await readStoredUpdates(ctx, edit.docId);
    if (!stored) return { status: "refused" as const, reason: "not-found" as const };
    if ("tooLarge" in stored) return { status: "refused" as const, reason: "too-large" as const };
    return {
      status: "ok" as const,
      editId: edit._id,
      docId: edit.docId,
      pageId: edit.pageId,
      projectId: edit.projectId,
      title: target.page.title,
      inverse: edit.inverse,
      touched: edit.touched,
      updates: stored.updates,
      seq: stored.seq,
    };
  },
});

export const commitUndo = internalMutation({
  args: {
    subject: v.string(),
    editId: v.id("mcpEdits"),
    grantId: v.optional(v.id("mcpGrants")),
    by: v.union(v.literal("agent"), v.literal("person")),
    seq: v.number(),
    chunks: v.array(v.bytes()),
  },
  returns: v.union(
    v.object({ status: v.literal("ok") }),
    v.object({ status: v.literal("stale") }),
    v.object({ status: v.literal("refused"), reason: v.union(writeRefusal, v.literal("already-undone")) }),
  ),
  handler: async (ctx, args) => {
    const edit = await ctx.db.get(args.editId);
    if (!edit || edit.subject !== args.subject) return { status: "refused" as const, reason: "not-found" as const };
    if (edit.undoneAt !== undefined) return { status: "refused" as const, reason: "already-undone" as const };
    const target = await writable(ctx, { subject: args.subject, grantId: args.grantId, docId: edit.docId });
    if (typeof target === "string") return { status: "refused" as const, reason: target };
    if (!(await append(ctx, edit.docId, args.seq, args.chunks))) return { status: "stale" as const };
    await ctx.db.patch(edit._id, { undoneAt: Date.now(), undoneBy: args.by, inverse: undefined });
    if (edit.inverse) await ctx.storage.delete(edit.inverse);
    await recordAudit(ctx, {
      actorId: args.subject,
      actorKind: "user",
      action: "mcp.undo",
      projectId: target.project._id,
      subjectKind: "page",
      subjectId: target.page._id,
      meta: { ids: { edit: edit._id, by: args.by, ...(args.grantId ? { grant: args.grantId } : {}) } },
    });
    return { status: "ok" as const };
  },
});

/** An inverse the action stored for an edit that then did not land. */
export const discardInverse = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId);
    return null;
  },
});

const editView = v.object({
  editId: v.id("mcpEdits"),
  clientName: v.string(),
  createdAt: v.number(),
  counts,
  changedIds: v.array(v.string()),
  undoable: v.boolean(),
});

const view = (edit: Doc<"mcpEdits">) => ({
  editId: edit._id,
  clientName: edit.clientName,
  createdAt: edit.createdAt,
  counts: edit.counts,
  changedIds: edit.changedIds,
  undoable: edit.inverse !== undefined,
});

/**
 * The agent edit a page offers to undo: its owner's newest one that is still
 * undoable and neither undone nor kept. Only the owner is shown it — the
 * connection and the edit are theirs.
 */
export const pendingOnPage = query({
  args: { docId: v.string() },
  returns: v.union(v.null(), editView),
  handler: async (ctx, args) => {
    const subject = await ownerId(ctx);
    if (!subject) return null;
    const edits = await ctx.db
      .query("mcpEdits")
      .withIndex("by_doc_and_created", (q) => q.eq("docId", args.docId))
      .order("desc")
      .take(20);
    const edit = edits.find(
      (e) => e.subject === subject && e.inverse !== undefined && e.undoneAt === undefined && e.keptAt === undefined,
    );
    return edit ? view(edit) : null;
  },
});

/** The person's recent agent edits across their pages, for Settings → Agents. */
export const recentEdits = query({
  args: {},
  returns: v.array(v.object({ ...editView.fields, pageTitle: v.string(), undoneAt: v.optional(v.number()), pageId: v.id("pages"), projectId: v.id("projects") })),
  handler: async (ctx) => {
    const subject = await ownerId(ctx);
    if (!subject) return [];
    const edits = await ctx.db
      .query("mcpEdits")
      .withIndex("by_subject_and_created", (q) => q.eq("subject", subject))
      .order("desc")
      .take(10);
    const out = [];
    for (const edit of edits) {
      const page = await ctx.db.get(edit.pageId);
      out.push({ ...view(edit), pageTitle: page?.title ?? "Deleted page", undoneAt: edit.undoneAt, pageId: edit.pageId, projectId: edit.projectId });
    }
    return out;
  },
});

/** "Keep": the page stops offering to undo this edit. It stays undoable from Settings. */
export const keepEdit = mutation({
  args: { editId: v.id("mcpEdits") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subject = await requireOwner(ctx);
    const edit = await ctx.db.get(args.editId);
    if (!edit || edit.subject !== subject) throw new Error("Not found");
    if (edit.keptAt === undefined) await ctx.db.patch(edit._id, { keptAt: Date.now() });
    return null;
  },
});

/**
 * Hourly: inverses past `EDIT_UNDO_DAYS` are deleted, which is what ends an
 * edit's undo. The record itself stays, as the audit line does.
 */
export const expireInverses = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("mcpEdits")
      .withIndex("by_created", (q) => q.lt("createdAt", Date.now() - UNDO_MS))
      .order("desc")
      .take(200);
    for (const edit of stale) {
      if (!edit.inverse) continue;
      await ctx.storage.delete(edit.inverse);
      await ctx.db.patch(edit._id, { inverse: undefined });
    }
    return null;
  },
});
