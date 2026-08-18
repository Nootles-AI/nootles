/**
 * Where an audio link points, and how to play it.
 *
 * Pure functions over the URL alone — no network, no DOM — because the block
 * (to choose a player) and the AI projection (to say what a block holds) ask
 * the same question, and because that is what keeps this testable under the
 * edge runtime.
 *
 * The provider set is the four services a song link actually comes from:
 * Spotify, Apple Music, YouTube, SoundCloud. Each embeds by URL alone, no API
 * key — which is the property that lets an AI-written `src` become a playing
 * song with nothing but markup. A URL that names none of them is still kept:
 * a direct audio file plays natively, and anything else renders as a labelled
 * link rather than a broken player.
 */

export type AudioSource =
  | { kind: "spotify" | "apple" | "soundcloud"; embedUrl: string; height: number }
  | { kind: "youtube"; embedUrl: string }
  | { kind: "file"; url: string }
  | { kind: "link"; url: string };

const AUDIO_FILE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

/** A YouTube video id, and nothing that could smuggle markup into an iframe. */
const YT_ID = /^[A-Za-z0-9_-]{6,}$/;

export function classify(raw: string): AudioSource | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  // Only the web. A `javascript:` or `data:` URL must never reach an iframe
  // src or an anchor href, however it got into the block's props.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "open.spotify.com") {
    const m = url.pathname.match(
      /^\/(?:intl-[a-z]{2,4}(?:-[a-z]{2,4})?\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/,
    );
    if (m) {
      const [, what, id] = m;
      return {
        kind: "spotify",
        embedUrl: `https://open.spotify.com/embed/${what}/${id}`,
        // The compact player fits one thing; a collection gets the tall one.
        height: what === "track" || what === "episode" ? 152 : 352,
      };
    }
    return { kind: "link", url: url.href };
  }

  if (host === "music.apple.com" || host === "embed.music.apple.com") {
    if (/\/(album|song|playlist|station|music-video)\//.test(url.pathname)) {
      // Same path on the embed host. `?i=` narrows an album page to one song,
      // which the short player fits.
      const single = url.searchParams.has("i") || url.pathname.includes("/song/");
      return {
        kind: "apple",
        embedUrl: `https://embed.music.apple.com${url.pathname}${url.search}`,
        height: single ? 175 : 450,
      };
    }
    return { kind: "link", url: url.href };
  }

  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtube-nocookie.com"
  ) {
    const id =
      url.searchParams.get("v") ??
      url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
    if (id && YT_ID.test(id)) {
      return {
        kind: "youtube",
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      };
    }
    const list = url.searchParams.get("list");
    if (url.pathname === "/playlist" && list && YT_ID.test(list)) {
      return {
        kind: "youtube",
        embedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`,
      };
    }
    return { kind: "link", url: url.href };
  }
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    if (YT_ID.test(id)) {
      return {
        kind: "youtube",
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      };
    }
    return { kind: "link", url: url.href };
  }

  if (host === "soundcloud.com" || host === "on.soundcloud.com") {
    // The widget resolves the page itself, so every soundcloud.com URL that
    // names something — a track, a set, an artist — is playable as given.
    if (url.pathname.length > 1) {
      return {
        kind: "soundcloud",
        embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.href)}`,
        height: 166,
      };
    }
    return { kind: "link", url: url.href };
  }

  // An uploaded file lives in Convex storage, which serves no extension; a
  // file linked from elsewhere usually carries one.
  if (host.endsWith(".convex.cloud") || AUDIO_FILE.test(url.pathname)) {
    return { kind: "file", url: url.href };
  }

  return { kind: "link", url: url.href };
}

/** The one-word answer the AI projection prints: what plays here. */
export function describeSource(raw: string): string | null {
  const source = classify(raw);
  if (!source) return null;
  return source.kind === "apple" ? "apple music" : source.kind;
}
