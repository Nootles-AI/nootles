/**
 * Google Maps by URL alone — no key, no API.
 *
 * A pasted Maps link already carries what a card needs to exist: the place's
 * name and where it is. Reading it here means a location block works with
 * nothing configured, and the parts that DO need a key (search, photos,
 * ratings, drive time) are additions to a card that already stands up.
 *
 * The embed is the keyless `output=embed` form rather than the Embed API,
 * which wants a key for the same picture (measured 2026-08: it frames without
 * one). The outward link is the documented `api=1` search URL, which is the
 * form Google asks to be linked with.
 */

import type { Location } from "./types";

export type MapsRead = {
  name?: string;
  query?: string;
  at?: { lat: number; lng: number };
  place?: string;
};

const MAPS_HOSTS = new Set([
  "google.com",
  "maps.google.com",
  "goo.gl",
  "maps.app.goo.gl",
]);

/** A short link says nothing until it is followed, which the server does. */
export function isShortMapsUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    return host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

export function isMapsUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!MAPS_HOSTS.has(host) && !host.endsWith(".google.com")) return false;
    return host.includes("goo.gl") || url.pathname.startsWith("/maps") || url.searchParams.has("q");
  } catch {
    return false;
  }
}

const LATLNG = /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/;

export function parseMapsUrl(raw: string): MapsRead | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!isMapsUrl(raw)) return null;

  const read: MapsRead = {};

  // /maps/place/Blue+Bottle+Coffee/@37.7955,-122.3937,17z
  const place = url.pathname.match(/\/place\/([^/@]+)/)?.[1];
  if (place) read.name = decodeURIComponent(place.replace(/\+/g, " ")).trim();

  const search = url.pathname.match(/\/search\/([^/@]+)/)?.[1];
  if (search) read.query = decodeURIComponent(search.replace(/\+/g, " ")).trim();

  const at = url.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) read.at = { lat: Number(at[1]), lng: Number(at[2]) };

  const q = url.searchParams.get("q") ?? url.searchParams.get("query");
  if (q) {
    const pair = q.match(LATLNG);
    if (pair) read.at = { lat: Number(pair[1]), lng: Number(pair[2]) };
    else if (!read.name) read.query = q;
  }

  // Both spellings Google uses for a place id in a share link.
  const id =
    url.searchParams.get("query_place_id") ?? url.searchParams.get("place_id");
  if (id) read.place = id;

  // A link that named nothing at all is not worth a card.
  return read.name || read.query || read.at ? read : null;
}

/** What the card asks Maps to draw: the place if we can name it, else the pin. */
export function mapQuery(location: Pick<Location, "name" | "address" | "at">): string {
  const named = [location.name, location.address].filter(Boolean).join(", ");
  if (named) return named;
  return location.at ? `${location.at.lat},${location.at.lng}` : "";
}

export function embedUrl(location: Pick<Location, "name" | "address" | "at">): string {
  const query = mapQuery(location);
  if (!query) return "";
  return `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=16&output=embed`;
}

export function linkUrl(location: Pick<Location, "name" | "address" | "at" | "place">): string {
  const query = mapQuery(location);
  const id = location.place ? `&query_place_id=${encodeURIComponent(location.place)}` : "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}${id}`;
}

/** Directions to here, from wherever the reader is when they press it. */
export function directionsUrl(
  location: Pick<Location, "name" | "address" | "at" | "place">,
): string {
  const query = mapQuery(location);
  const id = location.place
    ? `&destination_place_id=${encodeURIComponent(location.place)}`
    : "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}${id}`;
}
