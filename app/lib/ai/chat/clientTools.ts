"use client";

import type { z } from "zod";
import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { loadIconCatalog } from "@/app/components/editor/canvas/icons/registry";
import { handlesFor } from "@/app/components/editor/album/handle";
import { applyAlbumOps } from "@/app/components/editor/album/ops";
import { parseAlbum } from "@/app/components/editor/album/parse";
import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { readYDocUpdates } from "@/app/lib/sync/ydocRead";
import { AI } from "../aiConfig";
import { albumIndex } from "../albumRead";
import { compileDocHtml } from "../html/compile";
import type { DocNode } from "../html/grammar";
import { parseDocHtml } from "../html/parse";
import { redeemDrawnStubs, toDocHtml, toDocHtmlWithin } from "../html/serialize";
import { project, type AnyBlock, type DocIndex } from "../projection";
import type { ReviewSession } from "../review/session";
import { blocksFromSnapshot, yReader } from "../snapshot";
import { resolveBatch, warnRejected } from "../validate";
import { noSuchPage, TOOLS } from "./tools";

/** The surface the agent acts on: the page on screen, and its live editor. */
export type ToolContext = {
  convex: ConvexReactClient;
  projectId: Id<"projects">;
  /** Where an edit is staged for the user to keep or discard. */
  review: ReviewSession;
  /**
   * The page on screen, as the workspace resolved it. Read when the tool runs,
   * not when the call arrived: one step routinely carries an `open_page` and
   * the tools that act on what it opened, and the workspace only resolves the
   * new page a React commit later.
   */
  openPageId: () => Id<"pages"> | null;
  openPage: (pageId: Id<"pages">) => void;
  editorFor: (pageId: Id<"pages">) => Promise<LiveEditor>;
};

/** `<nt-diagram ref="d3"></nt-diagram>` — a drawing placed by name. */
const REF = /<nt-diagram\b[^>]*\bref="([^"]+)"[^>]*>\s*<\/nt-diagram\s*>/gi;

/** One op as the model may write it, which is not quite one op as `ops.ts` takes it. */
type AlbumToolOp = z.infer<typeof TOOLS.album_edit.inputSchema>["ops"][number];

/**
 * Redeems every `ref` in the model's HTML for the drawing it names.
 *
 * A string pass rather than a DOM one on purpose: this runs BEFORE
 * `parseDocHtml`, whose whole first act is to lift code and maths out of reach
 * of the HTML parser, and a DOM round trip here would mangle exactly what that
 * protects. A name with no drawing behind it is left standing — the compiler
 * reads the empty element as an empty canvas, which is visibly wrong rather
 * than silently wrong, and `notPlaced` tells the model which name failed.
 */
export function expandRefs(html: string, drawings: ReadonlyMap<string, string>): {
  html: string;
  missing: string[];
} {
  const missing: string[] = [];
  const out = html.replace(REF, (whole, ref: string) => {
    const drawing = drawings.get(ref);
    if (drawing) return drawing;
    missing.push(ref);
    return whole;
  });
  return { html: out, missing };
}

/**
 * The browser's half of the tool set.
 *
 * Inputs are re-validated here rather than trusted: the model's arguments have
 * only been checked against the schema the provider was given, and this side is
 * about to hand them to Convex.
 */
export async function runClientTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case "read_page": {
      const { pageId, expand } = TOOLS.read_page.inputSchema.parse(input);
      return await readPage(ctx, pageId as Id<"pages">, expand);
    }
    case "open_page": {
      const { pageId } = TOOLS.open_page.inputSchema.parse(input);
      return await openPage(ctx, pageId as Id<"pages">);
    }
    case "read_open_page": {
      const { expand } = TOOLS.read_open_page.inputSchema.parse(input ?? {});
      return await readOpenPage(ctx, expand);
    }
    case "edit_page": {
      const { pageId, html, replacing } = TOOLS.edit_page.inputSchema.parse(input);
      return await editPage(ctx, pageId as Id<"pages">, html, replacing);
    }
    case "album_edit": {
      const { pageId, blockId, ops } = TOOLS.album_edit.inputSchema.parse(input);
      return await albumEdit(ctx, pageId as Id<"pages">, blockId, ops);
    }
    case "look_at": {
      const { blockId, items } = TOOLS.look_at.inputSchema.parse(input);
      return await lookAt(ctx, blockId, items);
    }
    default:
      throw new Error(`No client tool named ${name}`);
  }
}

/**
 * An album's ops, applied through the applier every other edit goes through.
 *
 * The ops are turned into the album's own markup and handed to `edit_page`'s
 * machinery, which diffs it against the live block. That is what makes this a
 * cheaper way to SAY an edit rather than a second way to make one: the same
 * compiler, the same validator, and above all the same review — an agent that
 * drops eleven pictures from a moodboard leaves the user the same keep-or-
 * discard they get from any other change.
 *
 * Read live and applied late. The user may have dragged a tile between the
 * agent reading the album and this running, and every op names its pictures by
 * handle, so a reorder they made in between survives instead of being reverted
 * by an op that meant a position.
 */
async function albumEdit(
  ctx: ToolContext,
  pageId: Id<"pages">,
  blockId: string,
  ops: AlbumToolOp[],
): Promise<string> {
  // For the guard, not the row: a page id from another project, or one that
  // never existed, is refused here in words the model can act on.
  await fetchPage(ctx, pageId);
  ctx.openPage(pageId);
  const editor = await ctx.editorFor(pageId);
  const document = editor.document as unknown as AnyBlock[];

  const block = findAlbum(document, blockId);
  if (!block) {
    return [
      `That edit was not applied, and nothing on the page changed. There is no album with id "${blockId}" on this page.`,
      "Read the page again and use the `at` from the <nt-album> stub it gives you.",
    ].join("\n");
  }

  const album = { ...parseAlbum(String(block.props.data ?? "")), id: blockId };

  // Refs are redeemed BEFORE anything is applied: fetching the pictures is the
  // one part of this that can fail slowly, and half an album's worth of new
  // photographs landing beside a failure is worse than none.
  const wanted = [...new Set(ops.flatMap((op) => (op.op === "add" ? op.refs : [])))];
  const landed = wanted.length
    ? await ctx.convex.action(api.albums.ingest, { refs: wanted })
    : [];
  const bySrc = new Map(landed.map((item) => [item.ref, item]));
  const unknownRefs = wanted.filter((ref) => !bySrc.has(ref));

  const applied = applyAlbumOps(
    album,
    ops.map((op) =>
      op.op === "add"
        ? {
            op: "add" as const,
            items: op.refs.flatMap((ref) => {
              const found = bySrc.get(ref);
              return found ? [{ kind: "image" as const, src: found.src, w: found.w, h: found.h }] : [];
            }),
            ...(op.at !== undefined ? { at: op.at } : {}),
          }
        : op,
    ),
  );

  const complaints = [
    applied.missing.length
      ? `No picture in this album answers to ${applied.missing.map((h) => `"${h}"`).join(", ")} — those ops did nothing.`
      : "",
    unknownRefs.length
      ? `${unknownRefs.map((r) => `"${r}"`).join(", ")} could not be fetched, and ${unknownRefs.length === 1 ? "that picture was" : "those pictures were"} not added.`
      : "",
  ].filter(Boolean);

  const next = serializeAlbum(applied.album);
  if (next === serializeAlbum({ ...album, id: blockId })) {
    return [
      "Nothing to do — the album already reads that way.",
      ...complaints,
    ].join("\n");
  }

  const current = parseDocHtml(toDocHtml(document));
  const batch = compileDocHtml(parseDocHtml(next), { current, anchorBlockId: blockId });
  if (!batch.ops.length) return ["Nothing to do — the album already reads that way.", ...complaints].join("\n");

  const index = project(document).index;
  const resolved = resolveBatch(batch, index);
  if (!resolved.ok) {
    warnRejected("album_edit", resolved);
    return notApplied(resolved.errors, index);
  }
  try {
    await ctx.review.stage({ pageId, editor, batch: resolved.batch });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[album_edit] stage failed\n  ", error);
    }
    return [
      "The album could not be changed just now — nothing on the page changed, and",
      "this was not a problem with your ops. Call album_edit once more with the SAME ops.",
    ].join("\n");
  }

  const kept = applied.album.items.length;
  return [
    `Done: the album now holds ${kept} picture${kept === 1 ? "" : "s"}${
      applied.album.cols ? ` in ${applied.album.cols} columns` : ""
    }. The user reviews this and may discard it.`,
    ...complaints,
    "",
    await albumIndex(ctx.convex, editor.document as unknown as AnyBlock[], [blockId]),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The last tier of seeing: a few of an album's pictures, at full size.
 *
 * Fetched here rather than named for the model to fetch, because a storage URL
 * is a bearer and this browser is the only place holding a session that can
 * derive one. What goes back is inline data, which the tool's `toModelOutput`
 * on the server turns into media parts.
 */
async function lookAt(
  ctx: ToolContext,
  blockId: string,
  items: string[],
): Promise<{ images: { handle: string; dataUri: string; mediaType: string }[]; error?: string }> {
  const pageId = ctx.openPageId();
  if (!pageId) throw new Error("No page is open. Call list_pages, then open_page.");
  const editor = await ctx.editorFor(pageId);
  const block = findAlbum(editor.document as unknown as AnyBlock[], blockId);
  if (!block) return { images: [], error: `There is no album with id "${blockId}" on the open page.` };

  const album = parseAlbum(String(block.props.data ?? ""));
  const handles = handlesFor(album.items);
  const wanted = items.slice(0, AI.album.lookAtMost);
  const images: { handle: string; dataUri: string; mediaType: string }[] = [];

  for (const handle of wanted) {
    const at = handles.indexOf(handle);
    const item = at === -1 ? null : album.items[at];
    // A video's poster is the frame its tile shows, so looking at a film means
    // looking at that — there is nothing else a still request could mean.
    const src = item?.kind === "video" ? item.poster : item?.src;
    if (!src) continue;
    const blob = await fetch(src)
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);
    if (!blob) continue;
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("unreadable"));
      reader.readAsDataURL(blob);
    }).catch(() => "");
    if (dataUri) images.push({ handle, dataUri, mediaType: blob.type || "image/webp" });
  }

  return images.length
    ? { images }
    : {
        images: [],
        error: `None of ${wanted.map((h) => `"${h}"`).join(", ")} is a picture in that album. Read the page again for its handles.`,
      };
}

/** The album block an agent named, from anywhere in the document. */
function findAlbum(blocks: AnyBlock[], id: string): AnyBlock | null {
  for (const block of blocks) {
    if (block.id === id) return block.type === "album" ? block : null;
    const hit = block.children?.length ? findAlbum(block.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * The write half of the one vocabulary: HTML in, ops out.
 *
 * The model's HTML is diffed against the page's own HTML, so the ops it compiles
 * to are the difference and nothing else — untouched blocks produce no ops and
 * therefore nothing for the user to review. A batch that does not resolve is
 * answered rather than thrown, in the dialect: a wrong id is something the model
 * can act on, and it is the only part of a rejection it can even read.
 */
async function editPage(
  ctx: ToolContext,
  pageId: Id<"pages">,
  html: string,
  replacing: string[] | undefined,
): Promise<string> {
  // The model's HTML may place icons; the registry must be able to answer
  // before anything parses it.
  await loadIconCatalog();
  // Drawings are redeemed from their own table — the tool result named them
  // and carried nothing else, so this query is where the pictures actually
  // arrive. Fetched only when the edit places any.
  const named = [...html.matchAll(REF)].map((m) => m[1]);
  const drawings = named.length
    ? new Map(
        Object.entries(
          await ctx.convex.query(api.ai.drawings.get, { refs: [...new Set(named)] }),
        ),
      )
    : new Map<string, string>();
  const placed = expandRefs(html, drawings);
  if (placed.missing.length) {
    return [
      `That edit was not applied, and nothing on the page changed. There ${
        placed.missing.length === 1 ? "is no drawing" : "are no drawings"
      } named ${placed.missing.map((r) => `"${r}"`).join(", ")}.`,
      "Use the ref each draw call returned, exactly as it came back — or call draw again.",
    ].join("\n");
  }
  const page = await fetchPage(ctx, pageId);
  // The applier needs the live editor, and only the open page has one.
  ctx.openPage(pageId);
  const editor = await ctx.editorFor(pageId);
  const document = editor.document as unknown as AnyBlock[];

  // Reads hand the model drawn pictures as addressed stubs; here each returned
  // stub is redeemed for the shapes it stands for, from the live document. Both
  // sides of the diff then hold the full picture, so a kept stub is no change.
  const drawn = redeemDrawnStubs(placed.html, document);
  if (drawn.missing.length) {
    return [
      `That edit was not applied, and nothing on the page changed. There is no drawn picture at ${drawn.missing
        .map((a) => `"${a}"`)
        .join(", ")} any more — it may have moved or been deleted.`,
      "Read the page again and return its drawn stubs exactly as it gives them.",
    ].join("\n");
  }
  const source = drawn.html;

  const next = parseDocHtml(source);
  const current = parseDocHtml(toDocHtml(document));
  // An id the page does not have has to be caught here, because the compiler
  // cannot: it is handed a FRAGMENT, so "not in the current document" reads to
  // it as "new block", and a mistyped id would quietly duplicate the block the
  // model meant to rewrite. Taken from `current`, not from the document, so that
  // "the page has this block" means the same thing to the guard as it does to
  // the compiler — anything the round trip drops is a block neither can address,
  // and a guard that let it through would wave the duplicate past. Shape ids
  // inside a diagram are deliberately not checked — there the element list is
  // the whole diagram, so an unfamiliar one genuinely does mean a new shape.
  const known = new Set(taggedIds(current));
  const unknown = [...taggedIds(next), ...(replacing ?? [])].filter((id) => !known.has(id));
  if (unknown.length) {
    return [
      `That edit was not applied, and nothing on the page changed. This page has no block with ${
        unknown.length === 1 ? "id" : "ids"
      } ${unknown.map((id) => `"${id}"`).join(", ")}.`,
      "Read the page again and use the ids it gives you; leave the id off a block you mean to add.",
    ].join("\n");
  }

  const batch = compileDocHtml(next, {
    current,
    // Only a fallback, for a page with nothing on it the model kept: without a
    // single tagged block, and nothing being replaced, there is no surrounding
    // structure to place against.
    anchorBlockId: document[document.length - 1]?.id,
    ...(replacing?.length ? { replacing } : {}),
  });
  if (!batch.ops.length) return "Nothing to do — the page already reads that way.";

  const index = project(document).index;
  const resolved = resolveBatch(batch, index);
  if (!resolved.ok) {
    warnRejected("edit_page", resolved);
    return notApplied(resolved.errors, index);
  }

  let staged;
  try {
    staged = await ctx.review.stage({
      pageId,
      editor,
      batch: resolved.batch,
      ...(replacing?.length ? { replacing } : {}),
    });
  } catch (error) {
    // A stage that dies (an editor mid-remount, a fork that would not take) is
    // transient, and the expensive parts of the turn — drawings from the draw
    // tool especially — are already in hand. Measured in the field before this
    // message existed: the agent read a thrown stage as its whole approach
    // failing and REDREW every frame, several times over. Say what actually
    // happened and what to keep.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[edit_page] stage failed\n  ", error);
    }
    return [
      "The edit could not be applied just now — nothing on the page changed, and",
      "this was not a problem with your HTML. Call edit_page once more with the",
      "SAME content. Reuse everything you already have — especially drawings from",
      "draw calls; do not draw them again.",
    ].join("\n");
  }
  const counts = [
    staged.added && `${staged.added} block${staged.added === 1 ? "" : "s"} added`,
    staged.removed && `${staged.removed} removed`,
    staged.changed && `${staged.changed} rewritten`,
  ].filter(Boolean);

  return [
    `Done: ${counts.join(", ") || "no visible change"}. The user reviews this and may discard any of it.`,
    "",
    pageHtml(editor.document as unknown as AnyBlock[], page.title),
  ].join("\n");
}

/**
 * A refusal the model can read.
 *
 * `resolveBatch`'s errors are written in the op layer's own vocabulary — op
 * kinds, op indices, tempIds — none of which the model has ever been shown or
 * can answer in; handed them, it retries the identical HTML. Only the ids
 * translate, and only the ones the page actually has. Everything else becomes an
 * honest no, because a remedy that does not exist is worse than none.
 */
function notApplied(errors: string[], index: DocIndex): string {
  const known = new Set([...index.blocks.keys(), ...index.shapes.keys(), ...index.edges.keys()]);
  const named = [
    ...new Set(errors.flatMap((e) => [...e.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => m[1]))),
  ].filter((id) => known.has(id));

  return [
    "That edit was not applied, and nothing on the page changed.",
    named.length
      ? `The page will not take what you wrote for ${named.map((id) => `"${id}"`).join(", ")}.`
      : "The page will not take the elements you wrote.",
    "Read it again. Anything new belongs there with no id at all — an id only ever addresses the one thing already using it.",
  ].join("\n");
}

/** Every block the model addressed by id, nested items included. */
function taggedIds(nodes: DocNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.id ? [node.id] : []),
    ...("children" in node && node.children ? taggedIds(node.children) : []),
  ]);
}

/**
 * Opens a page and waits for its document, so that the tool returning is the
 * same thing as the page being ready to work on. Every later tool call can then
 * assume the editor it needs exists.
 */
async function openPage(
  ctx: ToolContext,
  pageId: Id<"pages">,
): Promise<{ pageId: Id<"pages">; title: string }> {
  const page = await fetchPage(ctx, pageId);
  ctx.openPage(pageId);
  await ctx.editorFor(pageId);
  return { pageId, title: page.title };
}

/**
 * The open page from the editor the user is typing into, rather than from the
 * copy on the server: the snapshot is written on a debounce, so a page read that
 * way is a page as it was a moment ago — and an edit written against that reads
 * the last thing typed as a block to delete.
 */
async function readOpenPage(ctx: ToolContext, expand?: string[]): Promise<string> {
  const pageId = ctx.openPageId();
  if (!pageId) {
    throw new Error("No page is open. Call list_pages, then open_page.");
  }
  const [page, editor] = await Promise.all([
    fetchPage(ctx, pageId),
    ctx.editorFor(pageId),
  ]);
  return await pageRead(ctx, editor.document as unknown as AnyBlock[], page.title, expand);
}

/**
 * A page read, and the index for any album the read asked to expand.
 *
 * The index is fetched rather than serialized because it is not in the
 * document: what a photograph looks like is measured or described elsewhere
 * (see `albumRead`), and an expand is the one moment worth paying to learn it.
 * An album nobody expanded costs a single stub line.
 */
async function pageRead(
  ctx: ToolContext,
  blocks: AnyBlock[],
  title: string,
  expand?: string[],
): Promise<string> {
  const html = pageHtml(blocks, title, expand);
  if (!expand?.length) return html;
  const index = await albumIndex(ctx.convex, blocks, expand).catch(() => "");
  return index ? `${html}\n\n${index}` : html;
}

async function readPage(
  ctx: ToolContext,
  pageId: Id<"pages">,
  expand?: string[],
): Promise<string> {
  // The open page is read from the editor itself. The stored copy trails the
  // caret by a debounce, and `edit_page` diffs against the live document — so
  // reading the open page from the server hands the model a version of a block
  // the user has since typed into, and echoing it back unchanged compiles to a
  // setBlockContent that reverts them. Valid ids throughout, so neither the
  // id guard nor `resolveBatch` catches it.
  if (ctx.openPageId() === pageId) return await readOpenPage(ctx, expand);

  const page = await fetchPage(ctx, pageId);
  return await pageRead(ctx, await storedBlocks(ctx, page.docId), page.title, expand);
}

/**
 * A closed page's blocks from whichever pipeline holds it. On the legacy
 * side that is snapshot plus the steps taken since, because the snapshot
 * alone is not the document — it is written on a debounce that is dropped
 * whenever the server runs ahead (measured on the live deployment: snapshot
 * at version 743, document at 752). On the Yjs side it is snapshot chunks
 * plus the update tail, where order and overlap cannot matter.
 */
async function storedBlocks(ctx: ToolContext, docId: string): Promise<AnyBlock[]> {
  const state =
    process.env.NEXT_PUBLIC_YJS === "1"
      ? await ctx.convex.query(api.ydoc.state, { docId })
      : "legacy";
  if (state === "yjs") {
    const reader = yReader();
    try {
      reader.apply(await readYDocUpdates(ctx.convex, docId));
      return reader.blocks();
    } finally {
      reader.destroy();
    }
  }

  const snapshot = await ctx.convex.query(api.prosemirror.getSnapshot, {
    id: docId,
  });
  if (!snapshot.content) return [];
  const since = await ctx.convex.query(api.prosemirror.getSteps, {
    id: docId,
    version: snapshot.version,
  });
  return blocksFromSnapshot(snapshot.content, since.steps);
}

/**
 * A malformed id throws rather than returning null, and Convex's own message
 * opens with a request id and "Server Error" — which reads to the model as an
 * outage rather than as the typo it is. An id from another project is the same
 * mistake with a different cause, and there is one way out of all of them.
 */
async function fetchPage(ctx: ToolContext, pageId: Id<"pages">) {
  const page = await ctx.convex.query(api.pages.get, { pageId }).catch(() => null);
  if (!page || page.projectId !== ctx.projectId) throw new Error(noSuchPage(pageId));
  return page;
}

/**
 * The page in the dialect, bounded so one page cannot eat the context window.
 *
 * Whole blocks only, and it says how many it left out — a page that just stops
 * otherwise reads as a page that ends there, and the model writes the rest of it
 * back over the part it never saw.
 */
function pageHtml(blocks: AnyBlock[], title: string, expand?: string[]): string {
  const { html, dropped } = toDocHtmlWithin(blocks, AI.chat.maxPageChars, {
    title,
    // Drawn pictures read as addressed stubs unless asked for — hundreds of
    // kilobytes of path data the model must not spend its window on.
    collapseDrawn: true,
    // An album always reads as a stub. Its markup is storage URLs, which the
    // model can neither fetch nor write; what its pictures LOOK like comes from
    // the index appended below, and changing one is `album_edit`.
    collapseAlbums: true,
    ...(expand?.length ? { expandDrawn: new Set(expand) } : {}),
  });
  // A page nobody has opened yet serializes to nothing, and a tool that answers
  // with nothing reads as a tool that failed.
  if (!blocks.length) return `${html}\n<!-- this page is empty -->`.trim();
  if (!dropped) return html;
  return `${html}\n<!-- ${dropped} further block${
    dropped === 1 ? "" : "s"
  } on this page, not shown: it is too long to read in one go -->`;
}
