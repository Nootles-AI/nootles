import "server-only";

import type { Found, Service } from "@/app/components/editor/media/types";

/**
 * Searching the music services: the engine behind the block's search box and
 * the agent's `find_songs` tool.
 *
 * On the server for three reasons: Apple's search has unpublished rate limits
 * and one cache here answers for everyone, Spotify needs a token that must not
 * reach the browser, and both are normalised to one shape so the panel above
 * does not care which service it is showing.
 *
 * Apple needs no credentials at all and hands back a real 30-second preview
 * with every track. Spotify needs an app — SPOTIFY_CLIENT_ID and
 * SPOTIFY_CLIENT_SECRET — and hands back no preview at all: `preview_url` has
 * been null under client credentials since November 2024, which is why a
 * Spotify result is previewed by loading the same embed the block would play
 * (see SearchPanel). Without those two variables the service simply reports
 * itself unconfigured, and the block offers Apple alone rather than breaking.
 *
 * The agent reaches this directly rather than through the route above it: a
 * server fetching its own protected route arrives with no session and is sent
 * to the sign-in page. Same arrangement as `app/lib/places.ts`.
 *
 * SoundCloud is absent on purpose: its API answers 401 and it has not issued
 * client ids for years, so a SoundCloud track is something you paste.
 */

export type Answer = { results: Found[] } | { configured: false };

const LIMIT = 8;
const TIMEOUT_MS = 6000;

/** A few minutes is plenty: this is here for the typing, not for the day. */
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; answer: Answer }>();

/**
 * One answer per query for a few minutes, shared by the search box and the
 * agent. It lives in the engine rather than at either door, because the two
 * ask the same questions — a reader typing a song the agent just looked up
 * should cost nothing — and because Apple's rate limits are unpublished.
 *
 * An unconfigured answer is never kept: credentials can appear between one
 * request and the next, and a cached "no" would outlive them.
 */
async function remember(key: string, ask: () => Promise<Answer>): Promise<Answer> {
  const hit = cached(key);
  if (hit) return hit;
  const answer = await ask();
  if ("results" in answer) cache.set(key, { at: Date.now(), answer });
  return answer;
}

function cached(key: string): Answer | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.answer;
}

// ---------------------------------------------------------------- Apple ----

type ITunesTrack = {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
  previewUrl?: string;
  trackTimeMillis?: number;
  kind?: string;
};

async function appleSearch(query: string): Promise<Answer> {
  const url =
    "https://itunes.apple.com/search?media=music&entity=song&limit=" +
    LIMIT +
    "&term=" +
    encodeURIComponent(query);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { results: [] };
  const body = (await res.json()) as { results?: ITunesTrack[] };
  const results = (body.results ?? [])
    .filter((t) => t.kind === "song" && t.trackViewUrl && t.trackName)
    .map((t) => ({
      id: String(t.trackId),
      title: t.trackName!,
      artist: t.artistName ?? "",
      // The 100px art is what the API offers; the same path serves any size,
      // and a row is 36 points on a retina screen.
      artwork: t.artworkUrl100?.replace("100x100", "200x200"),
      url: t.trackViewUrl!,
      preview: t.previewUrl,
      durationMs: t.trackTimeMillis,
    }));
  return { results };
}

// -------------------------------------------------------------- Spotify ----

let token: { value: string; until: number } | null = null;

async function spotifyToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token && Date.now() < token.until) return token.value;

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) return null;
  // A minute early, so a token never expires mid-request.
  token = {
    value: body.access_token,
    until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  };
  return token.value;
}

type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms?: number;
  artists?: { name: string }[];
  album?: { images?: { url: string; width: number }[] };
  external_urls?: { spotify?: string };
};

async function spotifySearch(query: string): Promise<Answer> {
  const bearer = await spotifyToken();
  if (!bearer) return { configured: false };

  const res = await fetch(
    `https://api.spotify.com/v1/search?type=track&limit=${LIMIT}&q=${encodeURIComponent(query)}`,
    {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (res.status === 401) {
    // Stale token, most likely a redeploy: forget it and let the next try mint.
    token = null;
    return { results: [] };
  }
  if (!res.ok) return { results: [] };
  const body = (await res.json()) as { tracks?: { items?: SpotifyTrack[] } };
  const results = (body.tracks?.items ?? [])
    .filter((t) => t?.id && t.external_urls?.spotify)
    .map((t) => {
      const images = [...(t.album?.images ?? [])].sort((a, b) => a.width - b.width);
      return {
        id: t.id,
        title: t.name,
        artist: (t.artists ?? []).map((a) => a.name).join(", "),
        artwork: (images.find((i) => i.width >= 160) ?? images.at(-1))?.url,
        url: t.external_urls!.spotify!,
        durationMs: t.duration_ms,
      };
    });
  return { results };
}

// ----------------------------------------------------------------- route ---

export function apple(query: string): Promise<Answer> {
  return remember(`apple:${query.toLowerCase()}`, () => appleSearch(query));
}

export function spotify(query: string): Promise<Answer> {
  return remember(`spotify:${query.toLowerCase()}`, () => spotifySearch(query));
}

/** Whether a Spotify app is configured for this deployment. */
export function spotifyConfigured(): boolean {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

/**
 * One search, answered by the best shelf available.
 *
 * Spotify first when it is configured — its player is the one most readers
 * already have an account for — and Apple whenever Spotify is unavailable,
 * unconfigured, or comes back with nothing. Apple needs no credentials, so
 * there is always an answer, and the caller never has to know which of the two
 * it got: both return the same shape, and both return a REAL url, which is the
 * whole point of the exercise.
 */
export async function findSongs(
  query: string,
  service?: Service,
): Promise<{ service: Service; results: Found[] }> {
  const wanted: Service[] =
    service === "apple"
      ? ["apple"]
      : service === "spotify"
        ? ["spotify"]
        : spotifyConfigured()
          ? ["spotify", "apple"]
          : ["apple"];

  for (const which of wanted) {
    const answer = which === "spotify" ? await spotify(query) : await apple(query);
    if ("results" in answer && answer.results.length) {
      return { service: which, results: answer.results };
    }
  }
  return { service: wanted.at(-1)!, results: [] };
}
