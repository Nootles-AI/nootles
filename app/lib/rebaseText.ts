/**
 * Three-way merge for a short, whole-string value — a title — that two people
 * (or two tabs) can edit at once while it is saved as one string.
 *
 * Each side's change from the shared `base` is read as a single splice (common
 * prefix and suffix kept), which is exact for anything typed in one place. Two
 * splices that do not overlap both apply. Two that overlap keep `ours` over the
 * whole overlap: the side doing the merge is the one still typing there.
 *
 * Used on both ends: `Editable` rebases a field being typed into onto a value
 * that arrived, and `pages.rename` rebases a title written from a stale base
 * onto the one the row holds.
 */

export type Splice = {
  /** Start in the old string. */
  from: number;
  /** End (exclusive) in the old string. */
  to: number;
  /** What replaces `[from, to)`. */
  text: string;
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The single splice taking `a` to `b`, never cutting a surrogate pair. */
export function spliceOf(a: string, b: string): Splice {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && p < max && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && s < max - p && isLow(a.charCodeAt(a.length - s))) s--;
  return { from: p, to: a.length - s, text: b.slice(p, b.length - s) };
}

/** `ours` and `theirs` were both made from `base`; the result carries both. */
export function rebaseText(base: string, ours: string, theirs: string): string {
  if (ours === base || ours === theirs) return theirs;
  if (theirs === base) return ours;
  const o = spliceOf(base, ours);
  const t = spliceOf(base, theirs);
  // Theirs wholly before ours; at one point, theirs first so a caret after
  // what this side typed stays after it.
  if (t.to <= o.from) {
    return base.slice(0, t.from) + t.text + base.slice(t.to, o.from) + o.text + base.slice(o.to);
  }
  if (o.to <= t.from) {
    return base.slice(0, o.from) + o.text + base.slice(o.to, t.from) + t.text + base.slice(t.to);
  }
  // Overlap: ours across the union of both ranges, theirs around it.
  const lo = Math.min(o.from, t.from);
  const hi = Math.max(o.to, t.to);
  const oursGrew = ours.length - base.length;
  const theirsGrew = theirs.length - base.length;
  return theirs.slice(0, lo) + ours.slice(lo, hi + oursGrew) + theirs.slice(hi + theirsGrew);
}

/** Where an offset in `a` lands in `b`, `b` being `a` with one splice applied. */
export function mapOffset(a: string, b: string, offset: number): number {
  const { from, to, text } = spliceOf(a, b);
  if (offset <= from) return offset;
  if (offset >= to) return offset + b.length - a.length;
  return from + text.length;
}
