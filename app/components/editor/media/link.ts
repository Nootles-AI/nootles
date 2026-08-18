/**
 * Where a media link points, and how to play it.
 *
 * Pure functions over the URL alone — no network, no DOM — because the block
 * (to choose a player), the block spec (to decide whether a link makes the
 * block audio or video), and the AI projection (to say what a block holds)
 * all ask the same question, and because that is what keeps this testable
 * under the edge runtime.
 *
 * The provider set is where a song or a video link actually comes from.
 * Spotify, Apple Music, SoundCloud, YouTube and Vimeo embed by URL alone, no
 * API key — the property that lets an AI-written `src` become a playing thing
 * with nothing but markup. Uppbeat offers no embed at all (checked 2026-08:
 * no oEmbed, no player URL), so its tracks are recognised and shown as a
 * titled card that opens the page. Any other URL is still kept: a direct
 * media file plays natively, and the rest render as a labelled link rather
 * than a broken player.
 */

export type MediaSource =
  | { kind: "spotify" | "apple" | "soundcloud"; embedUrl: string; height: number }
  | { kind: "youtube" | "vimeo"; embedUrl: string }
  | { kind: "uppbeat"; url: string; label: string }
  | { kind: "file"; url: string; media: "audio" | "video" | null }
  | { kind: "link"; url: string };

const AUDIO_FILE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|m4v|ogv)$/i;

/** A YouTube video id, and nothing that could smuggle markup into an iframe. */
const YT_ID = /^[A-Za-z0-9_-]{6,}$/;

export function classify(raw: string): MediaSource | null {
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

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    // The id is the first all-digit segment wherever the URL keeps it —
    // /123, /channels/x/123, /groups/x/videos/123, player.vimeo.com/video/123.
    // The segment after a bare id is the unlisted hash, which the player
    // needs back as ?h=.
    const m = url.pathname.match(/^\/(?:.*\/)?(\d+)(?:\/([0-9a-zA-Z]+))?\/?$/);
    if (m) {
      const [, id, hash] = m;
      return {
        kind: "vimeo",
        embedUrl: `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`,
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

  if (host === "uppbeat.io") {
    const m = url.pathname.match(/^\/t\/([^/]+)\/([^/?]+)/);
    if (m) {
      const words = (slug: string) => slug.replace(/-/g, " ");
      return {
        kind: "uppbeat",
        url: url.href,
        label: `${words(m[2])} — ${words(m[1])}`,
      };
    }
    return { kind: "link", url: url.href };
  }

  // An uploaded file lives in Convex storage, which serves no extension — the
  // block that uploaded it knows which it is; a file linked from elsewhere
  // usually says so itself.
  if (AUDIO_FILE.test(url.pathname)) {
    return { kind: "file", url: url.href, media: "audio" };
  }
  if (VIDEO_FILE.test(url.pathname)) {
    return { kind: "file", url: url.href, media: "video" };
  }
  if (host.endsWith(".convex.cloud")) {
    return { kind: "file", url: url.href, media: null };
  }

  return { kind: "link", url: url.href };
}

/**
 * Which block a link belongs in — the media block is `audio` or `video` under
 * one face, and a committed link settles which. Null means the link says
 * nothing about it, and the block stays what it is.
 */
export function blockTypeFor(raw: string): "audio" | "video" | null {
  const source = classify(raw);
  if (!source) return null;
  switch (source.kind) {
    case "spotify":
    case "apple":
    case "soundcloud":
    case "uppbeat":
      return "audio";
    case "youtube":
    case "vimeo":
      return "video";
    case "file":
      return source.media;
    default:
      return null;
  }
}

/** The one-word answer the AI projection prints: what plays here. */
export function describeSource(raw: string): string | null {
  const source = classify(raw);
  if (!source) return null;
  return source.kind === "apple" ? "apple music" : source.kind;
}
