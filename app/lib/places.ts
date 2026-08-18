import "server-only";

import { isShortMapsUrl } from "@/app/components/editor/location/maps";
import type { PlaceHit } from "@/app/components/editor/location/types";

/**
 * Google Places: the engine behind the location block and the agent's
 * `find_places` tool.
 *
 * A place card stands up with no key at all: a pasted Maps link carries the
 * name and the coordinates, and the map itself frames without credentials.
 * This route is what ADDS to that card — searching by words, the photographs,
 * the rating, and how long it takes to drive there — and every one of those
 * needs GOOGLE_MAPS_API_KEY. Without it the route says so once, plainly, and
 * the block goes on working as the paste-a-link card it is.
 *
 * Photographs are proxied rather than linked: a Places photo URL carries the
 * key in the query string, so linking one would publish the key on every page
 * that shows a café. The proxy hands back the bytes and keeps the key here.
 *
 * `place_id` is stored on the card but nothing else from Google is cached
 * beyond this process — their terms are particular about that, and a name and
 * an address on a card the user assembled is theirs, not a copy of a database.
 */

const PLACES = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 8000;

export type Answer =
  | { places: PlaceHit[] }
  | { drive: string }
  | { resolved: string }
  | { configured: false }
  | { error: string };

const key = () => process.env.GOOGLE_MAPS_API_KEY ?? "";

/** Whether this deployment can ask Google anything at all. */
export const configured = () => Boolean(key());

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  photos?: { name?: string }[];
};

function toHit(place: GooglePlace): PlaceHit | null {
  if (!place.id || !place.displayName?.text) return null;
  return {
    place: place.id,
    name: place.displayName.text,
    ...(place.formattedAddress ? { address: place.formattedAddress } : {}),
    ...(place.location?.latitude !== undefined && place.location.longitude !== undefined
      ? { at: { lat: place.location.latitude, lng: place.location.longitude } }
      : {}),
    ...(place.rating !== undefined ? { rating: place.rating } : {}),
    ...(place.userRatingCount !== undefined ? { votes: place.userRatingCount } : {}),
    photos: (place.photos ?? [])
      .map((photo) => photo.name)
      .filter((name): name is string => Boolean(name))
      .slice(0, 6)
      .map((name) => `/api/places/photo?ref=${encodeURIComponent(name)}`),
  };
}

export async function search(query: string, near: string | null): Promise<Answer> {
  const body: Record<string, unknown> = { textQuery: query, maxResultCount: 8 };
  const at = near?.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (at) {
    // A bias, not a filter: "cafés" near the reader should mean theirs first,
    // but a named place across the world must still be findable.
    body.locationBias = {
      circle: {
        center: { latitude: Number(at[1]), longitude: Number(at[2]) },
        radius: 20000,
      },
    };
  }
  const res = await fetch(`${PLACES}/places:searchText`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key(),
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.photos",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { error: `search failed (${res.status})` };
  const found = (await res.json()) as { places?: GooglePlace[] };
  return {
    places: (found.places ?? []).map(toHit).filter((hit): hit is PlaceHit => hit !== null),
  };
}

export async function details(id: string): Promise<Answer> {
  const res = await fetch(`${PLACES}/places/${encodeURIComponent(id)}`, {
    headers: {
      "X-Goog-Api-Key": key(),
      "X-Goog-FieldMask":
        "id,displayName,formattedAddress,location,rating,userRatingCount,photos",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { error: `lookup failed (${res.status})` };
  const hit = toHit((await res.json()) as GooglePlace);
  return { places: hit ? [hit] : [] };
}

export async function photo(ref: string): Promise<Response> {
  const res = await fetch(
    `${PLACES}/${ref}/media?maxWidthPx=800&key=${encodeURIComponent(key())}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" },
  );
  if (!res.ok || !res.body) return new Response(null, { status: 404 });
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "image/jpeg",
      // A photograph of a café does not change; the URL names the exact one.
      "cache-control": "private, max-age=86400, immutable",
    },
  });
}

/** How long to drive from `from` to the place, in that place's own words. */
export async function drive(from: string, to: string): Promise<Answer> {
  const point = (value: string) => {
    const at = value.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    return at
      ? { location: { latLng: { latitude: Number(at[1]), longitude: Number(at[2]) } } }
      : { address: value };
  };
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key(),
      "X-Goog-FieldMask": "routes.duration",
    },
    body: JSON.stringify({
      origin: point(from),
      destination: point(to),
      travelMode: "DRIVE",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { error: `route failed (${res.status})` };
  const body = (await res.json()) as { routes?: { duration?: string }[] };
  const seconds = Number((body.routes?.[0]?.duration ?? "").replace("s", ""));
  if (!Number.isFinite(seconds) || seconds <= 0) return { error: "no route" };
  const minutes = Math.round(seconds / 60);
  return {
    drive:
      minutes < 60
        ? `${minutes} min`
        : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`.replace(" 0 min", ""),
  };
}

/**
 * What a short Maps link points at. No key: the redirect is public, and this
 * is only here because a browser cannot follow it without being told the
 * answer by someone who can.
 */
export async function resolve(url: string): Promise<Answer> {
  if (!isShortMapsUrl(url)) return { error: "not a short maps link" };
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (compatible; Nootles)" },
  });
  return res.url && res.url !== url ? { resolved: res.url } : { error: "did not resolve" };
}
