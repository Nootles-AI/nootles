import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DIGEST_LIMITS, searchTextOf } from "./shape";

/**
 * Documents in the context graph: an uploaded file, a linked Notion page —
 * anything read in whole and kept as text. Both connectors write through
 * here, so a document means the same thing whichever door it came in by: one
 * node under the project, a templated digest, and its text kept for
 * `read_context`.
 */

/** How much of a document's text is kept to be read back whole. */
export const BODY_CHARS = 60_000;

export type DocumentInput = {
  projectId: Id<"projects">;
  source: "files" | "notion";
  /** `file:<projectFiles id>` or `notion:<page id>` — unique within the project. */
  externalId: string;
  title: string;
  url?: string;
  /** Who added it, shown as its owner. */
  memberId: string;
  text: string;
  /** Headings, where the source marks them — Notion does, a PDF does not. */
  headings?: string[];
};

/**
 * A document's digest, templated like a page's: its first sentence, its
 * sections and how it opens, the words search finds it by, and its text.
 */
export function documentDigest(text: string, headings: readonly string[] = []) {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  const flat = clean.replace(/\s+/g, " ");
  const firstSentence = /^(.{20,}?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  const outline = headings.length ? `Sections: ${headings.slice(0, 12).join(" · ")}` : "";
  const summary = clip([outline, flat].filter(Boolean).join("\n"), DIGEST_LIMITS.summary);
  return {
    brief: clip(firstSentence, 140),
    summary,
    terms: [...headings, clean].join("\n").slice(0, DIGEST_LIMITS.terms),
    body: clean.slice(0, BODY_CHARS),
  };
}

/** Writes a document's node and text, replacing whatever it said before. */
export async function upsertDocument(ctx: MutationCtx, doc: DocumentInput): Promise<Id<"contextNodes">> {
  const digest = documentDigest(doc.text, doc.headings);
  const existing = await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", doc.projectId).eq("externalId", doc.externalId),
    )
    .unique();
  const fields = {
    title: doc.title,
    brief: digest.brief,
    ...(doc.url ? { url: doc.url } : {}),
  };
  const nodeId =
    existing?._id ??
    (await ctx.db.insert("contextNodes", {
      projectId: doc.projectId,
      source: doc.source,
      tier: "artifact",
      kind: "document",
      externalId: doc.externalId,
      owner: { memberId: doc.memberId },
      ...fields,
    }));
  if (existing) await ctx.db.patch(existing._id, fields);

  const text = {
    summary: digest.summary,
    summaryOrigin: "template" as const,
    terms: digest.terms,
    searchText: searchTextOf(doc.title, digest.terms),
    contentHash: "",
    body: digest.body,
    syncedAt: Date.now(),
    code: false,
  };
  const row = await ctx.db
    .query("contextNodeText")
    .withIndex("by_nodeId", (q) => q.eq("nodeId", nodeId))
    .unique();
  if (row) await ctx.db.patch(row._id, text);
  else await ctx.db.insert("contextNodeText", { nodeId, projectId: doc.projectId, ...text });
  return nodeId;
}

/** A document gone from its source: its node, its text and any edge to it. */
export async function removeDocument(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  externalId: string,
) {
  const node = await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", projectId).eq("externalId", externalId),
    )
    .unique();
  if (!node) return;
  const edges = [
    ...(await ctx.db
      .query("contextEdges")
      .withIndex("by_from_and_family_and_expiredAt", (q) => q.eq("from", node._id))
      .collect()),
    ...(await ctx.db
      .query("contextEdges")
      .withIndex("by_to_and_family_and_expiredAt", (q) => q.eq("to", node._id))
      .collect()),
  ];
  for (const id of new Set(edges.map((e) => e._id))) await ctx.db.delete(id);
  const text = await ctx.db
    .query("contextNodeText")
    .withIndex("by_nodeId", (q) => q.eq("nodeId", node._id))
    .unique();
  if (text) await ctx.db.delete(text._id);
  await ctx.db.delete(node._id);
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}
