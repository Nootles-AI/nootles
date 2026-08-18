"use client";

import { useRef, useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { put } from "../album/upload";
import { useReadOnly } from "../readOnly";
import { LinkIcon } from "../../Icons";
import { classify } from "./link";
import {
  AppleMusicMark,
  SoundCloudMark,
  SpotifyMark,
  YouTubeMark,
} from "./ProviderIcons";
import "./audio.css";

/**
 * The audio block's face: an empty one asks for a link or a file, a filled one
 * plays.
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
].join(",");

/** Audio is uploaded as chosen — no transcode lane — so the door is smaller. */
const MAX_AUDIO_BYTES = 60_000_000;

const EMBED_ALLOW =
  "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";

export function AudioSurface({
  url,
  title,
  onSet,
}: {
  url: string;
  title: string;
  onSet: (next: { url: string; name: string; caption: string }) => void;
}) {
  const readOnly = useReadOnly();
  const convex = useConvex();
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
    onSet({ url: trimmed, name: "", caption: "" });
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      setError("That isn't an audio file.");
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      setError("Too big — audio tops out at 60MB.");
      return;
    }
    setError("");
    setProgress(0);
    try {
      const uploaded = await put(convex, file, file.type, setProgress);
      onSet({ url: uploaded, name: file.name, caption: "" });
    } catch {
      setError("Upload failed — try again.");
    } finally {
      setProgress(null);
    }
  }

  if (!url) {
    // An empty audio block is an invitation, and a viewer has nothing to
    // accept: on the share route it renders as the nothing it holds.
    if (readOnly) return null;
    return (
      <div className="nt-audio">
        {progress !== null ? (
          <div className="nt-audio-drop is-busy">
            <span>Uploading — {Math.round(progress * 100)}%</span>
          </div>
        ) : (
          <div
            className="nt-audio-drop"
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
              className="nt-audio-input"
              placeholder="Paste an audio link…"
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
            <span className="nt-audio-marks" aria-hidden>
              <SpotifyMark />
              <AppleMusicMark />
              <YouTubeMark />
              <SoundCloudMark />
            </span>
            <span className="nt-audio-rule" />
            <button
              type="button"
              className="nt-audio-upload"
              onClick={() => picker.current?.click()}
            >
              Upload file
            </button>
            <input
              ref={picker}
              className="nt-audio-picker"
              type="file"
              accept={ACCEPT}
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        )}
        {error && <div className="nt-audio-error">{error}</div>}
      </div>
    );
  }

  const source = classify(url);
  let player: ReactNode;
  if (!source) {
    // props hold something no URL parser accepts; show it rather than lose it.
    player = (
      <div className="nt-audio-card">
        <LinkIcon width={15} height={15} />
        <span className="nt-audio-card-title">{title || url}</span>
      </div>
    );
  } else if (source.kind === "youtube") {
    player = (
      <iframe
        className="nt-audio-embed is-video"
        src={source.embedUrl}
        title="Audio player"
        allow={EMBED_ALLOW}
        allowFullScreen
        loading="lazy"
      />
    );
  } else if (source.kind === "file") {
    player = (
      <div className="nt-audio-file">
        {title && <div className="nt-audio-title">{title}</div>}
        <audio className="nt-audio-player" controls src={source.url} />
      </div>
    );
  } else if (source.kind === "link") {
    player = (
      <a className="nt-audio-card" href={source.url} target="_blank" rel="noreferrer">
        <LinkIcon width={15} height={15} />
        <span className="nt-audio-card-title">{title || source.url}</span>
        <span className="nt-audio-card-host">{new URL(source.url).hostname}</span>
      </a>
    );
  } else {
    player = (
      <iframe
        className="nt-audio-embed"
        src={source.embedUrl}
        height={source.height}
        title="Audio player"
        allow={EMBED_ALLOW}
        loading="lazy"
      />
    );
  }
  return (
    <div className="nt-audio">
      {player}
      {!readOnly && (
        <button
          type="button"
          className="nt-audio-swap"
          onClick={() => onSet({ url: "", name: "", caption: "" })}
        >
          Replace
        </button>
      )}
    </div>
  );
}
