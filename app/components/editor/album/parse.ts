import { DEFAULT_H, DEFAULT_W, MAX_COLS, type Album, type AlbumItem } from "./types";

/**
 * Album HTML → {@link Album}.
 *
 * Strict in what {@link serializeAlbum} writes, liberal in what this reads: the
 * grammar is authored by a model as well as by the uploader, so `<gallery>`
 * where the canonical tag is `<nt-album>`, a `<figure>` wrapped around a
 * picture, or `w="1600px"` are naming preferences rather than errors.
 *
 * Normalisation happens here, not in the serializer, which is what makes
 * `serializeAlbum(parseAlbum(html)) === html` true of canonical markup: parsing
 * lands on exactly the values the serializer would have written, missing sizes
 * included.
 */

/** Browsers give us DOMParser; a caller off the main thread injects one. */
export type ParseHtml = (html: string) => Document;

const defaultParseHtml: ParseHtml = (html) =>
  new DOMParser().parseFromString(html, "text/html");

/** Tags accepted as the surface element. `nt-album` is the one we write. */
const ROOT_TAGS = "nt-album, album, nt-gallery, gallery, nt-waterfall";

/** Tags accepted as an item, and the kind each means. */
const KINDS: Record<string, AlbumItem["kind"]> = {
  img: "image",
  image: "image",
  "nt-image": "image",
  video: "video",
  "nt-video": "video",
};

/** `"1600"`, `"1600px"` and `" 1600 "` all mean the same number; nothing else does. */
function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseFloat(value.trim().replace(/px$/i, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function parseAlbum(
  source: string,
  parseHtml: ParseHtml = defaultParseHtml,
): Album {
  const album: Album = { items: [] };
  if (!source.trim()) return album;

  const root = parseHtml(source).querySelector(ROOT_TAGS);
  if (!root) return album;

  const id = root.getAttribute("id");
  if (id) album.id = id;
  const w = num(root.getAttribute("w") ?? root.getAttribute("width"));
  if (w) album.w = w;

  // `querySelectorAll` rather than walking the children, so a picture a model
  // wrapped in a <figure> or a <div> is still the picture it meant.
  for (const el of root.querySelectorAll(Object.keys(KINDS).join(","))) {
    const src = el.getAttribute("src")?.trim();
    // A source is the one thing an item cannot be reconstructed without.
    if (!src) continue;
    const kind = KINDS[el.tagName.toLowerCase()];
    const poster = el.getAttribute("poster")?.trim();
    const span = num(el.getAttribute("span"));
    album.items.push({
      kind,
      src,
      w: num(el.getAttribute("w") ?? el.getAttribute("width")) ?? DEFAULT_W,
      h: num(el.getAttribute("h") ?? el.getAttribute("height")) ?? DEFAULT_H,
      // One column is the default, so it is written by omission — and a span
      // past the columns there are is the layout's problem, not the file's.
      ...(span && span > 1 ? { span: Math.min(MAX_COLS, span) } : {}),
      ...(kind === "video" && poster ? { poster } : {}),
    });
  }

  return album;
}
