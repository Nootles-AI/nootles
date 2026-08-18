"use client";

import { useRef, useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { put } from "../album/upload";
import { useReadOnly } from "../readOnly";
import { LinkIcon, Search } from "../../Icons";
import { classify } from "./link";
import { useVerified } from "./verify";
import {
  AppleMusicMark,
  SoundCloudMark,
  SpotifyMark,
  VimeoMark,
  YouTubeMark,
} from "./ProviderIcons";
import "./media.css";

/**
 * The media block's face: an empty one asks for a link or a file, a filled one
 * plays. One face for two block types — `audio` and `video` share it, and the
 * committed link is what settles which of the two the block is (see
 * `MediaBlock.tsx`).
 *
 * A pasted provider link becomes that provider's player the moment it lands —
 * no confirm step, because the paste was the confirmation. A URL that is
 * neither a provider nor a file stays useful as a labelled link instead of
 * pretending to be a player; that is also what catches an AI-written link
 * that points somewhere no embed exists.
 */

const ACCEPT = [
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/quicktime",
].join(",");

/** Uploaded as chosen — no transcode lane here, unlike the album's videos. */
const MAX_AUDIO_BYTES = 60_000_000;
const MAX_VIDEO_BYTES = 250_000_000;

const EMBED_ALLOW =
  "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";

export function MediaSurface({
  url,
  title,
  fallbackKind,
  onSet,
}: {
  url: string;
  title: string;
  /** The block's own type: what a storage URL plays as when it can't say. */
  fallbackKind: "audio" | "video";
  onSet: (next: {
    url: string;
    name: string;
    caption: string;
    media: "audio" | "video" | null;
  }) => void;
}) {
  const readOnly = useReadOnly();
  const convex = useConvex();
  const verdict = useVerified(url);
  const picker = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  function commitLink(raw: string) {
    const trimmed = raw.trim();
    if (!classify(trimmed)) {
      setError("That doesn't look like a link.");
      return;
    }
    onSet({ url: trimmed, name: "", caption: "", media: null });
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    const media = file.type.startsWith("audio/")
      ? "audio"
      : file.type.startsWith("video/")
        ? "video"
        : null;
    if (!media) {
      setError("That isn't an audio or video file.");
      return;
    }
    const cap = media === "audio" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;
    if (file.size > cap) {
      setError(`Too big — ${media} tops out at ${Math.round(cap / 1_000_000)}MB.`);
      return;
    }
    setError("");
    setProgress(0);
    try {
      const uploaded = await put(convex, file, file.type, setProgress);
      onSet({ url: uploaded, name: file.name, caption: "", media });
    } catch {
      setError("Upload failed — try again.");
    } finally {
      setProgress(null);
    }
  }

  if (!url) {
    // An empty media block is an invitation, and a viewer has nothing to
    // accept: on the share route it renders as the nothing it holds.
    if (readOnly) return null;
    return (
      <div className="nt-media">
        {progress !== null ? (
          <div className="nt-media-drop is-busy">
            <span>Uploading — {Math.round(progress * 100)}%</span>
          </div>
        ) : (
          <div
            className="nt-media-drop"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              void upload(event.dataTransfer.files[0]);
            }}
          >
            <input
              className="nt-media-input"
              placeholder="Paste an audio or video link…"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError("");
              }}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                if (classify(text)) {
                  event.preventDefault();
                  commitLink(text);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draft.trim()) commitLink(draft);
              }}
            />
            <span className="nt-media-marks" aria-hidden>
              <SpotifyMark />
              <AppleMusicMark />
              <YouTubeMark />
              <SoundCloudMark />
              <VimeoMark />
            </span>
            <span className="nt-media-rule" />
            <button
              type="button"
              className="nt-media-upload"
              onClick={() => picker.current?.click()}
            >
              Upload file
            </button>
            <input
              ref={picker}
              className="nt-media-picker"
              type="file"
              accept={ACCEPT}
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        )}
        {error && <div className="nt-media-error">{error}</div>}
      </div>
    );
  }

  const source = classify(url);
  let player: ReactNode;
  if (!source) {
    // props hold something no URL parser accepts; show it rather than lose it.
    player = (
      <div className="nt-media-card">
        <LinkIcon width={15} height={15} />
        <span className="nt-media-card-title">{title || url}</span>
      </div>
    );
  } else if (source.kind === "search") {
    // Not a player and never was: a search stands for a song someone still has
    // to pick. Said plainly, because an unlabelled link here reads as a player
    // that failed.
    player = (
      <a className="nt-media-card" href={source.url} target="_blank" rel="noreferrer">
        <Search width={15} height={15} />
        <span className="nt-media-card-title">{title || source.query}</span>
        <span className="nt-media-card-host">Find on {source.provider}</span>
      </a>
    );
  } else if (verdict === "missing") {
    // The provider says plainly that this is not there. Showing the player
    // would put its 404 inside the document. What the block was FOR is the
    // title, so keep that and offer the search the link should have been; with
    // no title there is nothing to search for, so the dead link itself stays
    // visible rather than being dressed up as a query.
    player = (
      <a
        className="nt-media-card"
        href={
          title
            ? `https://open.spotify.com/search/${encodeURIComponent(title)}`
            : url
        }
        target="_blank"
        rel="noreferrer"
      >
        <Search width={15} height={15} />
        <span className="nt-media-card-title">{title || url}</span>
        <span className="nt-media-card-host">
          {title ? "link is dead — search" : "link is dead"}
        </span>
      </a>
    );
  } else {
    switch (source.kind) {
      case "youtube":
      case "vimeo":
        player = (
          <iframe
            className="nt-media-embed is-video"
            src={source.embedUrl}
            title="Media player"
            allow={EMBED_ALLOW}
            allowFullScreen
            loading="lazy"
          />
        );
        break;
      case "file": {
        const media = source.media ?? fallbackKind;
        player = (
          <div className="nt-media-file">
            {title && <div className="nt-media-title">{title}</div>}
            {media === "video" ? (
              <video className="nt-media-video" controls src={source.url} />
            ) : (
              <audio className="nt-media-player" controls src={source.url} />
            )}
          </div>
        );
        break;
      }
      case "uppbeat":
      case "link": {
        // Uppbeat has no embeddable player, so its card carries the track name.
        const label =
          title || (source.kind === "uppbeat" ? source.label : source.url);
        player = (
          <a className="nt-media-card" href={source.url} target="_blank" rel="noreferrer">
            <LinkIcon width={15} height={15} />
            <span className="nt-media-card-title">{label}</span>
            <span className="nt-media-card-host">{new URL(source.url).hostname}</span>
          </a>
        );
        break;
      }
      default:
        player = (
          <iframe
            className="nt-media-embed"
            src={source.embedUrl}
            height={source.height}
            title="Media player"
            allow={EMBED_ALLOW}
            loading="lazy"
          />
        );
    }
  }
  return (
    <div className="nt-media">
      {player}
      {!readOnly && (
        <button
          type="button"
          className="nt-media-swap"
          onClick={() => onSet({ url: "", name: "", caption: "", media: null })}
        >
          Replace
        </button>
      )}
    </div>
  );
}
