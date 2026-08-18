import { isPart, PARTS, type Location, type LocationImage, type Part } from "./types";

/**
 * Location HTML → {@link Location}.
 *
 * Strict in what `serializeLocation` writes, liberal in what this reads. A
 * model reaching for `<place>` where the canonical tag is `<nt-location>`, or
 * writing `lat`/`lng` as two attributes instead of one `at`, or spelling the
 * hidden parts with commas, is stating a naming preference rather than making
 * an error — and normalising happens HERE, never in the serializer, so there
 * is exactly one canonical form and it is the one the serializer writes.
 *
 * A card with no name is not a card. Everything else is optional, because a
 * place the model has only heard of is still worth putting down: a name and a
 * note is a valid location, and the map finds it by name.
 */

/** Browsers give us DOMParser; tests inject one. */
export type ParseHtml = (html: string) => Document;

const defaultParseHtml: ParseHtml = (html) =>
  new DOMParser().parseFromString(html, "text/html");

function num(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function coords(el: Element): Location["at"] {
  const at = el.getAttribute("at") ?? el.getAttribute("latlng");
  if (at) {
    const [lat, lng] = at.split(",").map((part) => Number(part.trim()));
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  const lat = num(el.getAttribute("lat"));
  const lng = num(el.getAttribute("lng") ?? el.getAttribute("lon"));
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

function parts(value: string | null): Part[] {
  if (!value) return [];
  const named = value
    .split(/[\s,]+/)
    .map((word) => word.trim().toLowerCase())
    .filter(isPart);
  // Deduped, because a list saying "rating rating" hides it exactly once, and
  // sorted into the vocabulary's own order — normalising is the parser's job,
  // so that two cards hiding the same parts are the same object as well as the
  // same text.
  return PARTS.filter((part) => named.includes(part));
}

export function parseLocation(
  html: string,
  parseHtml: ParseHtml = defaultParseHtml,
): Location {
  const doc = parseHtml(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root =
    doc.body.querySelector("nt-location, location, place") ?? doc.body.firstElementChild;

  if (!root) return { name: "", images: [], off: [] };

  const images: LocationImage[] = [];
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    images.push({ src, ...(img.hasAttribute("off") ? { off: true } : {}) });
  }

  const note =
    root.querySelector("note, description, desc, p")?.textContent?.trim() || undefined;

  const rating = num(root.getAttribute("rating") ?? root.getAttribute("stars"));

  return {
    ...(root.getAttribute("id") ? { id: root.getAttribute("id")! } : {}),
    // `title` because a model that has met `<audio title>` will reach for it.
    name: (root.getAttribute("name") ?? root.getAttribute("title") ?? "").trim(),
    ...(root.getAttribute("address")
      ? { address: root.getAttribute("address")!.trim() }
      : {}),
    ...(coords(root) ? { at: coords(root) } : {}),
    ...(root.getAttribute("place") ? { place: root.getAttribute("place")! } : {}),
    // A rating outside the stars it is drawn in is not a rating.
    ...(rating !== undefined && rating >= 0 && rating <= 5 ? { rating } : {}),
    ...(num(root.getAttribute("votes") ?? root.getAttribute("reviews")) !== undefined
      ? { votes: num(root.getAttribute("votes") ?? root.getAttribute("reviews")) }
      : {}),
    ...(note ? { note } : {}),
    images,
    off: parts(root.getAttribute("off") ?? root.getAttribute("hide")),
  };
}
