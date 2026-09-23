import { components } from "./_generated/api";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { DataModel, Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  channelAdmits,
  commentsProject,
  hasLiveLink,
  liveProject,
  refuseStandIn,
  roleForProject,
  standInActor,
  type DocChannel,
  type ProjectRole,
} from "./auth";

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
 *
 * The DOCUMENT channel only: a comments docId never matches `by_doc`, so every
 * caller that stamps, previews or migrates "the page this doc is" reaches
 * nothing for one. {@link pageAndChannelForDoc} is the lookup that sees both.
 */
export async function pageForDoc(ctx: QueryCtx, id: string) {
  return await ctx.db
    .query("pages")
    .withIndex("by_doc", (q) => q.eq("docId", id))
    .unique();
}

/**
 * Which page a docId belongs to, and which of its two documents it names.
 *
 * The channel is whichever index matched, so it is the database's answer
 * rather than the caller's: a docId cannot be spelled into the comments
 * channel, and a commenter handed the page's own docId is on the document
 * channel whatever they meant by it.
 */
export async function pageAndChannelForDoc(
  ctx: QueryCtx,
  id: string,
): Promise<{ page: Doc<"pages">; channel: DocChannel } | null> {
  const page = await pageForDoc(ctx, id);
  if (page) return { page, channel: "document" };
  const commented = await ctx.db
    .query("pages")
    .withIndex("by_comments_doc", (q) => q.eq("commentsDocId", id))
    .unique();
  return commented ? { page: commented, channel: "comments" } : null;
}

/**
 * The channels a caller serves. The default everywhere is the document alone,
 * so a pipeline written before comments — presence, previews, the legacy sync
 * API, the NML migrator — refuses a comments docId without knowing it exists.
 * Only `ydoc.ts`, whose one log carries both documents, opts into both.
 */
export const DOCUMENT_ONLY: readonly DocChannel[] = ["document"];
export const ANY_CHANNEL: readonly DocChannel[] = ["document", "comments"];

/** What an admitted docId resolved to. */
export type DocAccess = {
  page: Doc<"pages">;
  project: Doc<"projects">;
  channel: DocChannel;
  role: ProjectRole | null;
};

/**
 * The page, its live project and the caller's role on it, or null for a
 * docId that names nothing live on an accepted channel — or a comments docId
 * on a project whose comments are turned off.
 */
async function resolveDoc(
  ctx: QueryCtx,
  id: string,
  channels: readonly DocChannel[],
): Promise<DocAccess | null> {
  const found = await pageAndChannelForDoc(ctx, id);
  if (!found || !channels.includes(found.channel)) return null;
  const project =
    found.channel === "comments" ? await commentsProject(ctx, found.page) : await liveProject(ctx, found.page);
  if (!project) return null;
  return { ...found, project, role: await roleForProject(ctx, project) };
}

/**
 * Reads are open to anyone with a role on the project, and — on the document
 * channel only — to anonymous holders of a live share link. There is no token
 * to inspect here — the sync API's args are just the docId — so for the
 * anonymous case the capability IS the docId: a server-minted UUID that
 * `share.view` discloses only while a link is live. Revoking the last link
 * closes this door too. The comments channel takes no such fallback
 * (`auth.channelAdmits`).
 */
export async function checkRead(
  ctx: QueryCtx,
  id: string,
  channels: readonly DocChannel[] = DOCUMENT_ONLY,
): Promise<DocAccess> {
  const access = await readAccess(ctx, id, channels);
  if (!access) throw new Error("Not found");
  return access;
}

/**
 * {@link checkRead} as a question, for the one read-level write that must bend
 * rather than break: a presence heartbeat. Access can end while a tab is still
 * announcing itself — a link turned off mid-session — and that tab's last
 * heartbeat is routine, not a server error.
 */
export async function mayRead(
  ctx: QueryCtx,
  id: string,
  channels: readonly DocChannel[] = DOCUMENT_ONLY,
): Promise<boolean> {
  return (await readAccess(ctx, id, channels)) !== null;
}

async function readAccess(
  ctx: QueryCtx,
  id: string,
  channels: readonly DocChannel[],
): Promise<DocAccess | null> {
  const access = await resolveDoc(ctx, id, channels);
  return access &&
    channelAdmits({ channel: access.channel, access: "read", role: access.role, linkLive: hasLiveLink(access.project) })
    ? access
    : null;
}

/**
 * Writes need a writing role for the channel — owner or editor on the page
 * itself, and commenters as well on its comments.
 *
 * The fourth write gate, alongside the ones in `auth.ts`: document content
 * reaches this without passing through any of them, so an operator's stand-in
 * is refused here too, on both channels. Both sync pipelines land on it, so
 * one check covers every step and every Yjs update.
 */
export async function checkWrite(
  ctx: QueryCtx,
  id: string,
  channels: readonly DocChannel[] = DOCUMENT_ONLY,
): Promise<DocAccess> {
  await refuseStandIn(ctx);
  const access = await hasWriteRole(ctx, id, channels);
  if (!access) throw new Error("Not found");
  return access;
}

async function hasWriteRole(
  ctx: QueryCtx,
  id: string,
  channels: readonly DocChannel[] = DOCUMENT_ONLY,
): Promise<DocAccess | null> {
  const access = await resolveDoc(ctx, id, channels);
  return access &&
    channelAdmits({ channel: access.channel, access: "write", role: access.role, linkLive: false })
    ? access
    : null;
}

/**
 * {@link checkWrite} as a question, for the one kind of write that is a
 * courtesy rather than an intent: derived data a reader offers to leave
 * behind (`previews.set`). A viewer's card making that offer is routine, and
 * routine must not be a thrown server error. Same gate, same stand-in rule.
 */
export async function mayWrite(
  ctx: QueryCtx,
  id: string,
  channels: readonly DocChannel[] = DOCUMENT_ONLY,
): Promise<boolean> {
  if (await standInActor(ctx)) return false;
  return (await hasWriteRole(ctx, id, channels)) !== null;
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
  await checkWrite(ctx, id, DOCUMENT_ONLY);
  const migrated = await ctx.db
    .query("ydocs")
    .withIndex("by_doc", (q) => q.eq("docId", id))
    .unique();
  if (migrated) throw new Error("This page has moved to Yjs sync — reload.");
}

/** Comments documents are born on Yjs and never had a legacy pipeline. */
async function checkLegacyRead(ctx: QueryCtx, id: string) {
  await checkRead(ctx, id, DOCUMENT_ONLY);
}

export const { getSnapshot, submitSnapshot, latestVersion, getSteps, submitSteps } =
  prosemirrorSync.syncApi<DataModel>({
    checkRead: checkLegacyRead,
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
