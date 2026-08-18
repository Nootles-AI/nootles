/**
 * What a song looks like once either service has answered.
 *
 * Its own module, and deliberately not beside the route: both halves need this
 * shape, and the client must not reach into a server-only module to find out
 * what it is being sent.
 */

export type Service = "spotify" | "apple";

export type Found = {
  id: string;
  title: string;
  artist: string;
  artwork?: string;
  /** The page URL — what the block stores, and what `classify` reads. */
  url: string;
  /** Playable audio. Apple only; Spotify has none to give. */
  preview?: string;
  durationMs?: number;
};
