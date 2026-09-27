/**
 * `find_places` photographs, as the model holds them: a short name per picture
 * rather than its address.
 *
 * A Places photo address is a proxy URL around Google's photo resource name —
 * a couple of hundred characters of URL-encoded, high-entropy text, and a card
 * carries up to six. Handed those, the model spent ~15–20K characters of every
 * search on them and had to copy each back character for character into
 * `<img src>`, and a slip was a broken picture on the card (NT-98).
 *
 * So a search's addresses wait in the holding pen `draw` and `write` use, one
 * row per search, and the model is given `p3f9a2c1b0e.4` — the row's ref and
 * the picture's place in it. `edit_page` redeems the names before it parses,
 * so the page stores the real address and every later read shows it as ever.
 * These are the pure halves both sides load.
 */

/** Where `app/lib/places.ts` points every photograph. */
const PROXY = "/api/places/photo?ref=";

/** A photograph's name as the model writes it in an `<img src>`. */
const PHOTO_SRC = /(\bsrc=")(p[0-9a-f]{10})\.(\d+)(")/g;

/** Each place with its photographs renamed `ref.n`, and the addresses the names stand for. */
export function namePhotos<T extends { photos: string[] }>(
  places: readonly T[],
  ref: string,
): { places: T[]; urls: string[] } {
  const urls: string[] = [];
  const named = places.map((place) => ({
    ...place,
    photos: place.photos.map((url) => `${ref}.${urls.push(url) - 1}`),
  }));
  return { places: named, urls };
}

/** The search rows an edit's HTML names photographs from. */
export function photoRefs(html: string): string[] {
  return [...new Set([...html.matchAll(PHOTO_SRC)].map((m) => m[2]))];
}

/**
 * The HTML with every photograph name swapped for its address, or the names
 * that have none — a search from another day, or a name the model made up.
 * `rows` maps a search's ref to what the pen holds for it.
 */
export function redeemPhotos(
  html: string,
  rows: Readonly<Record<string, string>>,
): { html: string } | { missing: string[] } {
  const missing: string[] = [];
  const out = html.replace(PHOTO_SRC, (whole, open: string, ref: string, n: string, close: string) => {
    const url = addresses(rows[ref])?.[Number(n)];
    if (url) return `${open}${url}${close}`;
    missing.push(`${ref}.${n}`);
    return whole;
  });
  return missing.length ? { missing: [...new Set(missing)] } : { html: out };
}

function addresses(row: string | undefined): string[] | null {
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row);
    // Only ever the proxy's own addresses, whatever else a row might hold.
    return Array.isArray(parsed) &&
      parsed.every((url) => typeof url === "string" && url.startsWith(PROXY))
      ? parsed
      : null;
  } catch {
    return null;
  }
}
