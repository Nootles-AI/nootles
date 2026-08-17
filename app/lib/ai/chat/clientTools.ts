"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { AI } from "../aiConfig";
import { compileDocHtml } from "../html/compile";
import type { DocNode } from "../html/grammar";
import { parseDocHtml } from "../html/parse";
import { toDocHtml, toDocHtmlWithin } from "../html/serialize";
import { project, type AnyBlock, type DocIndex } from "../projection";
import type { ReviewSession } from "../review/session";
import { blocksFromSnapshot, blocksFromYUpdates } from "../snapshot";
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
      const { pageId } = TOOLS.read_page.inputSchema.parse(input);
      return await readPage(ctx, pageId as Id<"pages">);
    }
    case "open_page": {
      const { pageId } = TOOLS.open_page.inputSchema.parse(input);
      return await openPage(ctx, pageId as Id<"pages">);
    }
    case "read_open_page":
      return await readOpenPage(ctx);
    case "edit_page": {
      const { pageId, html, replacing } = TOOLS.edit_page.inputSchema.parse(input);
      return await editPage(ctx, pageId as Id<"pages">, html, replacing);
    }
    default:
      throw new Error(`No client tool named ${name}`);
  }
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
  const page = await fetchPage(ctx, pageId);
  // The applier needs the live editor, and only the open page has one.
  ctx.openPage(pageId);
  const editor = await ctx.editorFor(pageId);
  const document = editor.document as unknown as AnyBlock[];

  const next = parseDocHtml(html);
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

  const staged = await ctx.review.stage({
    pageId,
    editor,
    batch: resolved.batch,
    ...(replacing?.length ? { replacing } : {}),
  });
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
async function readOpenPage(ctx: ToolContext): Promise<string> {
  const pageId = ctx.openPageId();
  if (!pageId) {
    throw new Error("No page is open. Call list_pages, then open_page.");
  }
  const [page, editor] = await Promise.all([
    fetchPage(ctx, pageId),
    ctx.editorFor(pageId),
  ]);
  return pageHtml(editor.document as unknown as AnyBlock[], page.title);
}

async function readPage(ctx: ToolContext, pageId: Id<"pages">): Promise<string> {
  // The open page is read from the editor itself. The stored copy trails the
  // caret by a debounce, and `edit_page` diffs against the live document — so
  // reading the open page from the server hands the model a version of a block
  // the user has since typed into, and echoing it back unchanged compiles to a
  // setBlockContent that reverts them. Valid ids throughout, so neither the
  // id guard nor `resolveBatch` catches it.
  if (ctx.openPageId() === pageId) return await readOpenPage(ctx);

  const page = await fetchPage(ctx, pageId);
  return pageHtml(await storedBlocks(ctx, page.docId), page.title);
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
    const meta = await ctx.convex.query(api.ydoc.meta, { docId });
    if (!meta) return [];
    const parts: ArrayBuffer[] = [];
    for (let part = 0; part < meta.snapshotParts; part++) {
      const chunk = await ctx.convex.query(api.ydoc.snapshot, {
        docId,
        gen: meta.snapshotSeq,
        part,
      });
      if (chunk) parts.push(chunk);
    }
    let cursor = meta.snapshotSeq;
    for (;;) {
      const rows = await ctx.convex.query(api.ydoc.updatesSince, {
        docId,
        afterSeq: cursor,
      });
      if (!rows.length) break;
      for (const row of rows) {
        parts.push(row.update);
        cursor = Math.max(cursor, row.seq);
      }
    }
    return blocksFromYUpdates(parts);
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
function pageHtml(blocks: AnyBlock[], title: string): string {
  const { html, dropped } = toDocHtmlWithin(blocks, AI.chat.maxPageChars, { title });
  // A page nobody has opened yet serializes to nothing, and a tool that answers
  // with nothing reads as a tool that failed.
  if (!blocks.length) return `${html}\n<!-- this page is empty -->`.trim();
  if (!dropped) return html;
  return `${html}\n<!-- ${dropped} further block${
    dropped === 1 ? "" : "s"
  } on this page, not shown: it is too long to read in one go -->`;
}
