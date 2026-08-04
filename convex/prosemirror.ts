import { components } from "./_generated/api";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { DataModel } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ownerId } from "./auth";

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
 * The page a sync document belongs to, or a refusal. Takes a query context so
 * one function serves both reads and writes.
 *
 * Requiring the page row is safe in both directions: `pages.create` mints the
 * `docId` server-side, so the row always exists before the editor is handed one.
 * A doc with no page is either another tenant's or one orphaned by `pages.remove`
 * — neither is readable.
 */
async function checkDoc(ctx: QueryCtx, id: string) {
  const owner = await ownerId(ctx);
  if (!owner) throw new Error("Not signed in");
  const page = await ctx.db
    .query("pages")
    .withIndex("by_doc", (q) => q.eq("docId", id))
    .unique();
  if (!page || page.ownerId !== owner) throw new Error("Not found");
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

export const { getSnapshot, submitSnapshot, latestVersion, getSteps, submitSteps } =
  prosemirrorSync.syncApi<DataModel>({
    checkRead: checkDoc,
    checkWrite: checkDoc,
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
