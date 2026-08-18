import { classify } from "@/app/components/editor/media/link";

/**
 * Does the thing a media block points at actually exist?
 *
 * A player is an iframe, so a link to a page that is not there renders as the
 * provider's own error sitting inside the document — which reads as our block
 * being broken rather than the link being wrong. The agent writes these links
 * itself, and measured on real asks it mostly writes real ones and otherwise
 * falls back to a search, but not always: an invented Apple album id got
 * through, well-formed and 404. So the block asks before it plays.
 *
 * On the server because the provider's negative is only legible here: Spotify
 * answers a missing track with a 404 that carries no CORS headers, so from the
 * browser a dead link and a dead network are the same thrown error — and a
 * player must never be taken away by silence.
 *
 * Three providers answer plainly (measured 2026-08): Spotify 200/404, YouTube
 * 200/400, SoundCloud 200/404. Apple Music and Vimeo do not — Apple's embed
 * host returns 200 for ids that do not exist and its own pages refuse a server
 * outright — so those are reported `unknown` and keep their player. An unknown
 * is not a failure; it is the honest answer.
 */

type Status = "ok" | "missing" | "unknown";

/** The URL that answers "is this real?", for the providers that answer it. */
function probe(url: string): string | null {
  const source = classify(url);
  if (!source) return null;
  const oembed = (endpoint: string, target: string) =>
    `${endpoint}${endpoint.includes("?") ? "&" : "?"}url=${encodeURIComponent(target)}`;

  switch (source.kind) {
    case "spotify":
      // oEmbed wants the page, not the embed; the id is the same either way.
      return oembed(
        "https://open.spotify.com/oembed",
        source.embedUrl.replace("/embed/", "/"),
      );
    case "youtube": {
      const id = source.embedUrl.match(/\/embed\/([A-Za-z0-9_-]{11})$/)?.[1];
      return id
        ? oembed(
            "https://www.youtube.com/oembed?format=json",
            `https://www.youtube.com/watch?v=${id}`,
          )
        : null;
    }
    case "soundcloud": {
      const target = new URL(source.embedUrl).searchParams.get("url");
      return target
        ? oembed("https://soundcloud.com/oembed?format=json", target)
        : null;
    }
    default:
      return null;
  }
}

/**
 * One answer per URL for the life of the process. A track does not stop
 * existing while a page is open, and every reader of a shared page would
 * otherwise ask the same question again.
 */
const answers = new Map<string, Status>();

/** How long to wait on a provider before calling it unknown. */
const TIMEOUT_MS = 4000;

export async function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url");
  if (!url) return Response.json({ status: "unknown" satisfies Status });

  const cached = answers.get(url);
  if (cached) return Response.json({ status: cached });

  const target = probe(url);
  if (!target) return Response.json({ status: "unknown" satisfies Status });

  let status: Status = "unknown";
  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    // Only a plain yes or a plain no counts. A rate limit or a bad gateway is
    // the provider having a moment, not the song being gone.
    if (res.ok) status = "ok";
    else if (res.status === 400 || res.status === 404) status = "missing";
  } catch {
    status = "unknown";
  }

  if (status !== "unknown") answers.set(url, status);
  return Response.json(
    { status },
    { headers: { "cache-control": "private, max-age=3600" } },
  );
}
