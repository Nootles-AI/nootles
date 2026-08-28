/**
 * Photographs from the web, for an album to be filled from.
 *
 * Unsplash, for one reason beyond the licence: every result already carries its
 * dimensions, its dominant colour and a sentence describing it. That is exactly
 * the index `imageMeta` keeps, published by the people who own the picture — so
 * a found photograph arrives fully described, and never needs the captioning
 * pass at all. The whole of this lane costs no model call.
 *
 * What comes back is refs, never URLs. The URL is kept in a `foundImages` row
 * and the bytes are later fetched by the ingest action from that row — so the
 * only address this server ever fetches is one it minted itself, and there is
 * no path by which a URL the model wrote reaches a request.
 */

export type Found = {
  ref: string;
  url: string;
  w: number;
  h: number;
  alt: string;
  hex: string;
  credit: string;
  report?: string;
};

const ENDPOINT = "https://api.unsplash.com/search/photos";

export function imagesConfigured(): boolean {
  return Boolean(process.env.UNSPLASH_ACCESS_KEY);
}

type UnsplashPhoto = {
  id?: string;
  width?: number;
  height?: number;
  color?: string;
  alt_description?: string | null;
  description?: string | null;
  urls?: { raw?: string };
  user?: { name?: string; links?: { html?: string } };
  links?: { download_location?: string };
};

export async function findImages(
  query: string,
  opts: { count?: number; orientation?: string; colour?: string },
  signal?: AbortSignal,
): Promise<Found[]> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) throw new Error("no UNSPLASH_ACCESS_KEY");

  const address = new URL(ENDPOINT);
  address.searchParams.set("query", query);
  address.searchParams.set("per_page", String(Math.min(12, Math.max(1, opts.count ?? 5))));
  // Anything the provider would refuse outright is worth not asking for: a
  // rejected search reads to the agent as "there are no such pictures".
  if (opts.orientation) address.searchParams.set("orientation", opts.orientation);
  if (opts.colour && /^[a-z_]+$/.test(opts.colour)) {
    address.searchParams.set("color", opts.colour);
  }
  address.searchParams.set("content_filter", "high");

  const res = await fetch(address, {
    headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
    signal,
  });
  if (!res.ok) throw new Error(`image search failed: ${res.status}`);

  const { results } = (await res.json()) as { results?: UnsplashPhoto[] };
  return (results ?? []).flatMap((photo): Found[] => {
    const url = photo.urls?.raw;
    if (!photo.id || !url || !photo.width || !photo.height) return [];
    const who = photo.user?.name?.trim();
    return [
      {
        ref: `img_${photo.id}`,
        url,
        w: photo.width,
        h: photo.height,
        alt: (photo.alt_description ?? photo.description ?? "").trim().slice(0, 90),
        hex: photo.color ?? "#808080",
        // Carried on the row rather than derived later: the licence asks that
        // credit travel with the picture, and the row is the last place both
        // the picture and its photographer are in hand.
        credit: who
          ? `${who} on Unsplash${photo.user?.links?.html ? ` (${photo.user.links.html})` : ""}`
          : "Unsplash",
        ...(photo.links?.download_location
          ? { report: `${photo.links.download_location}&client_id=${key}` }
          : {}),
      },
    ];
  });
}
