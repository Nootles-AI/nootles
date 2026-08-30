import { components } from "./_generated/api";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isTrashed, refuseStandIn, roleForProject } from "./auth";

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
 * Reads are open to anyone with a role on the project and to anonymous holders
 * of a live share link. There is no token to inspect here — the sync API's
 * args are just the docId — so for the anonymous case the capability IS the
 * docId: a server-minted UUID that `share.view` discloses only while a link is
 * live. Revoking the last link closes this door too.
 */
export async function checkRead(ctx: QueryCtx, id: string) {
  const page = await pageForDoc(ctx, id);
  if (!page || isTrashed(page)) throw new Error("Not found");
  const project = await ctx.db.get(page.projectId);
  if (!project || isTrashed(project)) throw new Error("Not found");
  if (await roleForProject(ctx, project)) return;
  if (project.shareToken || project.editShareToken) return;
  throw new Error("Not found");
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
  const page = await pageForDoc(ctx, id);
  if (!page || isTrashed(page)) throw new Error("Not found");
  const project = await ctx.db.get(page.projectId);
  if (!project || isTrashed(project)) throw new Error("Not found");
  const role = await roleForProject(ctx, project);
  if (role !== "owner" && role !== "editor") throw new Error("Not found");
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
async function checkLegacyWrite(ctx: QueryCtx, id: string) {
  await checkWrite(ctx, id);
  const migrated = await ctx.db
    .query("ydocs")
    .withIndex("by_doc", (q) => q.eq("docId", id))
    .unique();
  if (migrated) throw new Error("This page has moved to Yjs sync — reload.");
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
