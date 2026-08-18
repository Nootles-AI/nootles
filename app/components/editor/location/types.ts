/**
 * What a place card holds.
 *
 * Everything here is a FACT ABOUT THE PLACE — its name, where it is, what it
 * is rated — or a decision about what to show of it. Nothing here is about the
 * person looking: drive time is deliberately absent, because it is different
 * for every reader and true for none of them once written down. It is asked
 * for live, by the block, from wherever the reader happens to be.
 */

/** The parts of a card that can be switched off. The name cannot; it is the card. */
export const PARTS = ["map", "address", "rating", "photos", "note", "link"] as const;
export type Part = (typeof PARTS)[number];

export type LocationImage = {
  src: string;
  /** Kept but not shown — a picture the search offered and nobody chose. */
  off?: boolean;
};

export type Location = {
  /** The block's own id, put on the root the way a diagram carries its. */
  id?: string;
  /** Required. A card with no name is not a place, it is a pin. */
  name: string;
  address?: string;
  at?: { lat: number; lng: number };
  /** Google's own id for the place, when we were told it. */
  place?: string;
  rating?: number;
  votes?: number;
  note?: string;
  images: LocationImage[];
  /** Parts switched off, sorted. Silence means the whole card. */
  off: Part[];
  /**
   * Show how long it takes to drive here. Opt-in and off by default, because
   * answering it means asking the reader's browser where they are — a prompt
   * no one should get merely for opening a page with a café on it.
   */
  drive?: boolean;
};

/** How many of the pictures a search offers are shown without being asked. */
export const DEFAULT_SHOWN_IMAGES = 2;

export function emptyLocation(name = ""): Location {
  return { name, images: [], off: [] };
}

export function isPart(value: string): value is Part {
  return (PARTS as readonly string[]).includes(value);
}

/** The pictures actually on the card, in order. */
export function shown(location: Location): LocationImage[] {
  return location.images.filter((image) => !image.off);
}

export function showing(location: Location, part: Part): boolean {
  return !location.off.includes(part);
}

/**
 * A place as Google describes it — the shape the search route returns and the
 * agent's `find_places` tool hands the model.
 *
 * Here rather than beside the route because both halves need it and the client
 * must not reach into a server-only module to find out what it is being sent.
 */
export type PlaceHit = {
  place: string;
  name: string;
  address?: string;
  at?: { lat: number; lng: number };
  rating?: number;
  votes?: number;
  /** Our own proxy URLs, one per photograph Google offered. */
  photos: string[];
};
