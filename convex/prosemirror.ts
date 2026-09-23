import { components } from "./_generated/api";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { recordDocumentEdit } from "./audit";
import { isTrashed, readsDocuments, refuseStandIn, roleForProject, standInActor } from "./auth";

/**
 * Collaborative sync for each page's block flow. The client (BlockNote) talks to
 * these endpoints via useBlockNoteSync; steps + snapshots are persisted by the
 * prosemirror-sync component.
 *
 * These endpoints reach document content without going through `pages`, so they
 * carry their own check — the table-level one never sees them.
 */
const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

/**
 * The page a sync document belongs to, or null.
 *
 * Requiring the page row is safe in both directions: `pages.create` mints the
 * `docId` server-side, so the row always exists before the editor is handed one.
 * A doc with no page is either another tenant's or one orphaned by `pages.remove`
 * — neither is readable.
 */
export async function pageForDoc(ctx: QueryCtx, id: string) {
  return await ctx.db
    .query("pages")
    .withIndex("by_doc", (q) => q.eq("docId", id))
    .unique();
}

/**
 * Reads are open to whoever `readsDocuments` admits: anyone with a role, and
 * on a personal project anonymous holders of a live share link too. Revoking
 * the last link closes that door.
 */
export async function checkRead(ctx: QueryCtx, id: string) {
  const page = await pageForDoc(ctx, id);
  if (!page || isTrashed(page)) throw new Error("Not found");
  const project = await ctx.db.get(page.projectId);
  if (!project || !(await readsDocuments(ctx, project))) throw new Error("Not found");
}

/**
 * Writes need a writing role — the owner, or an editor-link claimant.
 *
 * The fourth write gate, alongside the three in `auth.ts`: document content
 * reaches this without passing through any of them, so an operator's stand-in
 * is refused here too. Both sync pipelines land on it, so one check covers
 * every step and every Yjs update.
 */
export async function checkWrite(ctx: QueryCtx, id: string) {
  await refuseStandIn(ctx);
  if (!(await hasWriteRole(ctx, id))) throw new Error("Not found");
}

async function hasWriteRole(ctx: QueryCtx, id: string): Promise<boolean> {
  const page = await pageForDoc(ctx, id);
  if (!page || isTrashed(page)) return false;
  const project = await ctx.db.get(page.projectId);
  if (!project || isTrashed(project)) return false;
  const role = await roleForProject(ctx, project);
  return role === "owner" || role === "editor";
}

/**
 * {@link checkWrite} as a question, for the one kind of write that is a
 * courtesy rather than an intent: derived data a reader offers to leave
 * behind (`previews.set`). A viewer's card making that offer is routine, and
 * routine must not be a thrown server error. Same gate, same stand-in rule.
 */
export async function mayWrite(ctx: QueryCtx, id: string): Promise<boolean> {
  if (await standInActor(ctx)) return false;
  return await hasWriteRole(ctx, id);
}

/**
 * Stamps the page as edited.
 *
 * Hung on `onSnapshot` rather than `checkWrite` deliberately: `checkWrite` runs
 * on every step submission, so stamping there would be a row write per
 * keystroke batch — the one thing the editor's debounce exists to avoid. A
 * snapshot is already the debounced event.
 */
async function touchPage(ctx: MutationCtx, id: string) {
  const page = await ctx.db
    .query("pages")
    .withIndex("by_doc", (q) => q.eq("docId", id))
    .unique();
  if (page) await ctx.db.patch(page._id, { updatedAt: Date.now() });
}

/**
 * The legacy pipeline's write gate: the shared role check, plus the freeze —
 * once a doc has moved to Yjs, a stale tab still running this pipeline must
 * not write steps nobody will ever read. Reads stay open for the migration
 * fetch itself and for viewers who haven't flipped over yet.
 */
async function checkLegacyWrite(ctx: MutationCtx, id: string) {
  await checkWrite(ctx, id);
  const migrated = await ctx.db
    .query("ydocs")
    .withIndex("by_doc", (q) => q.eq("docId", id))
    .unique();
  if (migrated) throw new Error("This page has moved to Yjs sync — reload.");
  // The gate is the one hook this pipeline gives that knows the writer. It
  // runs for snapshots as well as steps, so a legacy page counts a little
  // high: the same person in the same window either way.
  await recordDocumentEdit(ctx, id);
}

export const { getSnapshot, submitSnapshot, latestVersion, getSteps, submitSteps } =
  prosemirrorSync.syncApi<DataModel>({
    checkRead,
    checkWrite: checkLegacyWrite,
    onSnapshot: touchPage,
  });

/**
 * Gives a page a document that already has content in it.
 *
 * Every other page starts empty and is filled by the editor, so this is the one
 * path that writes a document nobody has opened yet — a template. `content` is
 * ProseMirror JSON built on the client, because assembling it means holding the
 * BlockNote schema and that is a browser bundle (see `app/lib/ai/snapshot.ts`,
 * which bridges the same gap in the other direction).
 *
 * Callers must already have authorized the page: this is a plain helper rather
 * than a mutation precisely so it cannot be reached from outside one.
 */
export async function seedDoc(ctx: MutationCtx, docId: string, content: object) {
  await prosemirrorSync.create(ctx, docId, content);
}
