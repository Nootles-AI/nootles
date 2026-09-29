"use node";

import { v, type Infer } from "convex/values";
import { DOMParser } from "linkedom";
import * as Y from "yjs";
import { internal } from "../_generated/api";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { project } from "@/app/lib/ai/projection";
import { nmlToAnyBlocks } from "@/app/lib/nml/model/projection";
import { decodeNmlDocument } from "@/app/lib/nml/yjs";
import type { NmlBlock, NmlDocument } from "@/app/lib/nml/schema";
import { nmlOutline, nmlSnippet } from "@/app/lib/mcp/outline";
import { docSummary, material as materialValidator } from "./docs";

/**
 * MCP Phase 3 — the model read of a served document, on the server.
 *
 * The stored update history (read cheaply in the isolate by `docs.readMaterial`)
 * is rebuilt into a Y.Doc here and decoded from its canonical `nml` root: never
 * the `prosemirror` compatibility root, never an HTML reader. The text is
 * `project()` over the NML adapter — the same stable-ID grammar every AI lane
 * reads, so a `⟦id⟧` an agent sees here is the id an editor, a checkpoint and a
 * future `edit_doc` all address. The outline beside it is for the card a person
 * sees, derived from the same decode.
 *
 * Node, for the reason `nmlVerify.ts` gives: rebuilding a document near the v1
 * limits needs more heap than an isolate has. And the projection reads canvas,
 * album, storyboard and location markup back through their parsers, which want
 * a `DOMParser`; linkedom stands in for the browser's, as in `diagramBand.ts`.
 */

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;

/** Past this the agent gets the start and is told how to ask for the rest. */
export const MAX_TEXT_CHARS = 200_000;

export function rebuild(updates: ArrayBuffer[]): NmlDocument {
  const doc = new Y.Doc();
  try {
    for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
    return decodeNmlDocument(doc);
  } finally {
    doc.destroy();
  }
}

function storageIds(blocks: NmlBlock[], out = new Set<string>()): Set<string> {
  for (const block of blocks) {
    if (
      (block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file") &&
      block.props.source?.kind === "storage"
    ) {
      out.add(block.props.source.storageId);
    }
    storageIds(block.children, out);
  }
  return out;
}

/** Signed URLs for uploaded media, so a projected image line points somewhere real. */
export async function mediaUrls(ctx: ActionCtx, document: NmlDocument): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const id of storageIds(document.blocks)) {
    const url = await ctx.storage.getUrl(id as Id<"_storage">).catch(() => null);
    if (url) urls.set(id, url);
  }
  return urls;
}

const outlineBlock = v.object({
  id: v.string(),
  type: v.string(),
  depth: v.number(),
  text: v.string(),
  level: v.optional(v.number()),
  checked: v.optional(v.boolean()),
  language: v.optional(v.string()),
});

const refusal = v.object({
  status: v.literal("refused"),
  reason: v.union(v.literal("not-found"), v.literal("not-served"), v.literal("too-large"), v.literal("corrupt")),
  detail: v.optional(v.string()),
});

const readResult = v.union(
  v.object({
    status: v.literal("ok"),
    doc: docSummary,
    text: v.string(),
    truncated: v.boolean(),
    blockCount: v.number(),
    outline: v.object({ blocks: v.array(outlineBlock), total: v.number(), truncated: v.boolean() }),
  }),
  refusal,
);

export const readDoc = internalAction({
  args: {
    subject: v.string(),
    grantId: v.id("mcpGrants"),
    ref: v.string(),
    focusBlockId: v.optional(v.string()),
    window: v.optional(v.number()),
  },
  returns: readResult,
  handler: async (ctx, args): Promise<Infer<typeof readResult>> => {
    const material: Infer<typeof materialValidator> = await ctx.runQuery(internal.mcp.docs.readMaterial, { subject: args.subject, ref: args.ref });
    if (material.status !== "ok") return material;
    let document: NmlDocument;
    try {
      document = rebuild(material.updates);
    } catch {
      // Served means verified, so this is a root damaged since — say so, never guess.
      return { status: "refused" as const, reason: "corrupt" as const };
    }
    const urls = await mediaUrls(ctx, document);
    let blocks;
    try {
      blocks = nmlToAnyBlocks(document, { resolveStorageUrl: (id) => urls.get(id) });
    } catch {
      return { status: "refused" as const, reason: "corrupt" as const };
    }
    const windowed =
      args.focusBlockId !== undefined
        ? { cursorBlockId: args.focusBlockId, window: Math.max(0, Math.min(50, Math.floor(args.window ?? 5))) }
        : {};
    const { text: projected, index } = project(blocks, windowed);
    // `project` marks the focus block for a model writing at a caret; an agent
    // asked for a region needs the region, not a caret.
    const text = projected.replace("   ◀ CURSOR IS HERE", "");
    const truncated = text.length > MAX_TEXT_CHARS;
    const outline = nmlOutline(document);
    await ctx.runMutation(internal.mcp.docs.recordRead, {
      subject: args.subject,
      grantId: args.grantId,
      pageId: material.doc.pageId,
      projectId: material.doc.projectId,
      blocks: outline.total,
    });
    return {
      status: "ok" as const,
      doc: material.doc,
      text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text,
      truncated,
      blockCount: index.blocks.size,
      outline,
    };
  },
});

/** At most this many documents are opened to find their first words. */
export const SNIPPET_DOCS = 25;

const listResult = v.object({
  total: v.number(),
  docs: v.array(
    v.object({
      docId: v.string(),
      pageId: v.id("pages"),
      projectId: v.id("projects"),
      title: v.string(),
      projectTitle: v.string(),
      updatedAt: v.number(),
      snippet: v.optional(v.string()),
      blockCount: v.optional(v.number()),
    }),
  ),
});

export const listDocs = internalAction({
  args: { subject: v.string(), query: v.optional(v.string()), limit: v.number() },
  returns: listResult,
  handler: async (ctx, args): Promise<Infer<typeof listResult>> => {
    const all: Infer<typeof docSummary>[] = await ctx.runQuery(internal.mcp.docs.servedDocs, { subject: args.subject });
    const needle = args.query?.trim().toLowerCase();
    const matching = needle
      ? all.filter((d) => d.title.toLowerCase().includes(needle) || d.projectTitle.toLowerCase().includes(needle))
      : all;
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit)));
    const docs = [];
    for (const [i, doc] of matching.slice(0, limit).entries()) {
      if (i >= SNIPPET_DOCS) {
        docs.push(doc);
        continue;
      }
      const read: Infer<typeof materialValidator> = await ctx.runQuery(internal.mcp.docs.readMaterial, {
        subject: args.subject,
        ref: doc.docId,
      });
      if (read.status !== "ok") {
        docs.push(doc);
        continue;
      }
      try {
        const document = rebuild(read.updates);
        docs.push({ ...doc, snippet: nmlSnippet(document, { title: doc.title }), blockCount: nmlOutline(document, { maxBlocks: 0 }).total });
      } catch {
        docs.push(doc);
      }
    }
    return { total: matching.length, docs };
  },
});

/** Search opens at most this many documents, most recently edited first. */
export const SEARCH_DOCS = 100;

const searchResult = v.object({
  scanned: v.number(),
  total: v.number(),
  hits: v.array(
    v.object({
      docId: v.string(),
      pageId: v.id("pages"),
      projectId: v.id("projects"),
      title: v.string(),
      projectTitle: v.string(),
      matches: v.array(v.object({ blockId: v.string(), type: v.string(), text: v.string() })),
      /** Matches in this document beyond the few shown. */
      more: v.number(),
    }),
  ),
});

/** The window of `text` around the first hit of `needle`, so a long block shows where it matched. */
function around(text: string, needle: string, radius = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0 || flat.length <= radius * 2) return flat.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(flat.length, at + needle.length + radius);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}

/**
 * Text search across the subject's served documents (NT-124): case-insensitive
 * substring over every block's text — the outline the card shows, so headings,
 * list items, tables, code and diagram shape labels all count — plus titles.
 * There is no content index for NML documents, so this decodes each one; it
 * reads the {@link SEARCH_DOCS} most recently edited and says so when there are more.
 */
export const searchDocs = internalAction({
  args: { subject: v.string(), query: v.string(), limit: v.number() },
  returns: searchResult,
  handler: async (ctx, args): Promise<Infer<typeof searchResult>> => {
    const needle = args.query.trim().toLowerCase();
    const all: Infer<typeof docSummary>[] = await ctx.runQuery(internal.mcp.docs.servedDocs, { subject: args.subject });
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit)));
    const hits: Infer<typeof searchResult>["hits"] = [];
    const scanned = all.slice(0, SEARCH_DOCS);
    for (const doc of scanned) {
      if (hits.length >= limit) break;
      const read: Infer<typeof materialValidator> = await ctx.runQuery(internal.mcp.docs.readMaterial, { subject: args.subject, ref: doc.docId });
      if (read.status !== "ok") continue;
      let document: NmlDocument;
      try {
        document = rebuild(read.updates);
      } catch {
        continue;
      }
      const blocks = nmlOutline(document, { maxBlocks: Number.MAX_SAFE_INTEGER, maxChars: Number.MAX_SAFE_INTEGER }).blocks;
      const found = blocks.filter((b) => b.text.toLowerCase().includes(needle));
      const titled = doc.title.toLowerCase().includes(needle);
      if (!found.length && !titled) continue;
      hits.push({
        docId: doc.docId,
        pageId: doc.pageId,
        projectId: doc.projectId,
        title: doc.title,
        projectTitle: doc.projectTitle,
        matches: found.slice(0, 3).map((b) => ({ blockId: b.id, type: b.type, text: around(b.text, needle) })),
        more: Math.max(0, found.length - 3),
      });
    }
    return { scanned: Math.min(scanned.length, all.length), total: all.length, hits };
  },
});
