import { v, type Infer } from "convex/values";

/**
 * What the indexer hands `graphStore.ts`, shared by both. Its own module
 * because the indexer runs in Node, and a Node module must not pull in a file
 * that defines queries or mutations.
 */

/** Rows per transaction — a batch of files carries their search text too. */
export const BATCH = 200;

export const node = v.object({
  kind: v.union(v.literal("repo"), v.literal("area"), v.literal("concern"), v.literal("file")),
  tier: v.union(v.literal("source"), v.literal("concern"), v.literal("artifact")),
  externalId: v.string(),
  /** The external id of the node this one sits inside, written in an earlier row. */
  parent: v.optional(v.string()),
  title: v.string(),
  brief: v.string(),
  summary: v.string(),
  terms: v.string(),
  url: v.optional(v.string()),
  styling: v.optional(v.boolean()),
});

export const edge = v.object({
  from: v.id("contextNodes"),
  to: v.id("contextNodes"),
  family: v.union(v.literal("contains"), v.literal("references"), v.literal("about")),
  type: v.string(),
  weight: v.optional(v.number()),
});

export type NodeInput = Infer<typeof node>;
export type EdgeInput = Infer<typeof edge>;
