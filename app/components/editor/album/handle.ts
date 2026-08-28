import type { AlbumItem } from "./types";

/**
 * A short name per picture, derived from the picture itself.
 *
 * Every part of the album that has to say WHICH picture — a React key, a drag
 * in progress, an agent's reorder, a row of stored metadata — needs a name that
 * survives the round trip through the document. Object identity cannot do it:
 * every commit re-serializes the album and the prop comes back to be parsed
 * again, so the objects are replaced each time. Position cannot do it either,
 * which is the whole point — a name is what a reorder is expressed IN, so it
 * must not be a position.
 *
 * So: the source, hashed. Derived rather than stored, which buys three things
 * that a written-in `id` attribute would each have cost something for. The album
 * grammar does not change, so `serializeAlbum(parseAlbum(html)) === html` stays
 * exactly as true as it was and there is no migration for albums already
 * written. A handle follows a picture through a copy-paste into another
 * document, because it was never anything but the picture. And metadata keyed by
 * handle is keyed by the photograph, so the same photograph used in two albums
 * is indexed once.
 *
 * The cost is that re-cutting a picture renames it. That is the right failure:
 * an agent's op against the old handle finds nothing and says so, rather than
 * landing on a picture that is no longer the one it was told about.
 */

/** Crockford's alphabet, lowercased: no i/l/o/u, so a handle cannot be misread. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** The shortest handle we will hand out. 32⁴ ≈ 1M, so a collision is the album's fault. */
const MIN = 4;
const MAX = 8;

/** FNV-1a, 32-bit. Not a security hash — a spreader, and a very fast one. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function base32(hash: number): string {
  let out = "";
  for (let i = 0; i < MAX; i++) {
    out += ALPHABET[(hash >>> (i * 4)) & 31];
    // Four bits per character out of a 32-bit hash would repeat after eight;
    // re-mixing keeps the later characters worth having.
    if (i === 5) hash = Math.imul(hash ^ (hash >>> 13), 0x01000193);
  }
  return out;
}

/**
 * Handles for an album, positionally parallel to its items.
 *
 * The length is chosen for the album as a whole, not per picture, so that the
 * handles the agent is shown all read alike and a list of them is scannable.
 * Two items with the SAME source — markup naming one picture twice — are the
 * one case a source cannot separate, and they take an occurrence suffix.
 */
export function handlesFor(items: readonly Pick<AlbumItem, "src">[]): string[] {
  const full = items.map((item) => base32(fnv1a(item.src)));
  const sources = new Set(items.map((item) => item.src));

  let length = MIN;
  while (length < MAX) {
    const prefixes = new Set<string>();
    // Distinct SOURCES must land on distinct prefixes; repeats of one source
    // are separated below and must not push the whole album to longer handles.
    items.forEach((item, i) => prefixes.add(`${full[i].slice(0, length)}`));
    if (prefixes.size === sources.size) break;
    length++;
  }

  const seen = new Map<string, number>();
  return items.map((item, i) => {
    const stem = full[i].slice(0, length);
    const n = seen.get(item.src) ?? 0;
    seen.set(item.src, n + 1);
    return n ? `${stem}-${n + 1}` : stem;
  });
}

/** Where each handle sits, for ops that address pictures by name. */
export function indexByHandle(items: readonly AlbumItem[]): Map<string, number> {
  const handles = handlesFor(items);
  return new Map(handles.map((handle, i) => [handle, i]));
}
