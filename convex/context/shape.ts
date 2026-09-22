import { v, type Infer } from "convex/values";

/**
 * What a page's digest carries from the browser to the graph.
 *
 * The browser writes it because reading a Y.Doc as blocks needs BlockNote's
 * schema, which is a browser bundle — the same reason `pagePreviews` is
 * client-written. No imports beyond validators, deliberately: this module is
 * read by Convex functions and by the browser.
 */
export const pageDigest = v.object({
  brief: v.string(),
  summary: v.string(),
  terms: v.string(),
  /** Page ids the page mentions, in document order, without repeats. */
  mentions: v.array(v.string()),
  contentHash: v.string(),
});

export type PageDigest = Infer<typeof pageDigest>;

export const DIGEST_LIMITS = {
  brief: 200,
  summary: 900,
  terms: 6000,
  mentions: 100,
} as const;

/** Whether a digest is within what the graph stores — the server refuses the rest. */
export function digestFits(d: PageDigest): boolean {
  return (
    d.brief.length <= DIGEST_LIMITS.brief &&
    d.summary.length <= DIGEST_LIMITS.summary &&
    d.terms.length <= DIGEST_LIMITS.terms &&
    d.mentions.length <= DIGEST_LIMITS.mentions &&
    d.contentHash.length <= 64
  );
}

/** What the full-text index reads: the title first, so a title match ranks. */
export function searchTextOf(title: string, terms: string): string {
  return terms ? `${title}\n${terms}` : title;
}
