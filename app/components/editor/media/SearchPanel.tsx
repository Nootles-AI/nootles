"use client";

import { useEffect, useRef, useState } from "react";
import type { Found } from "@/app/api/media/search/route";
import { Pause, Play } from "../../Icons";
import { classify } from "./link";
import { usePlayer } from "./playback";
import { SERVICES, useSearch, type Service } from "./search";

/**
 * The list under an armed media block: what the service found, and a way to
 * hear it before committing to it.
 *
 * Only ONE row is ever previewing, so only one row holds a player — which is
 * also how a preview joins the page's one-at-a-time rule for free: mounting it
 * registers it, and pressing play on another row unmounts the last one.
 *
 * Apple hands us real preview audio. Spotify hands us none, so its preview is
 * the same embed the block would end up playing, loaded only when asked —
 * a 152px player rather than a 36px row, which is why it takes the row's place
 * instead of sitting inside it.
 */

const NONE: Found[] = [];

function duration(ms: number | undefined): string {
  if (!ms) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Preview({ track, service }: { track: Found; service: Service }) {
  const embed = service === "spotify" ? classify(track.url) : null;
  const src = track.preview ?? (embed && "embedUrl" in embed ? embed.embedUrl : "");
  const ref = usePlayer(track.preview ? "file" : "spotify", src);

  if (track.preview) {
    return (
      <audio
        ref={ref}
        src={track.preview}
        autoPlay
        onEnded={(event) => event.currentTarget.blur()}
        className="nt-search-preview-audio"
      />
    );
  }
  if (!src) return null;
  return (
    <iframe
      ref={ref}
      className="nt-search-preview-embed"
      src={src}
      height={152}
      title={`${track.title} — preview`}
      allow="autoplay; encrypted-media"
      loading="lazy"
    />
  );
}

export function SearchPanel({
  service,
  query,
  onPick,
}: {
  service: Service;
  query: string;
  onPick: (track: Found) => void;
}) {
  const state = useSearch(service, query);
  const list = useRef<HTMLDivElement>(null);
  // One shared empty array rather than a fresh literal: this is a dependency of
  // the key handler below, and a new [] each render would rebind it each render.
  const results = state.status === "results" ? state.results : NONE;

  // Both cursors are held as the SONG they point at, never as a row number, so
  // a new set of results needs no resetting: the old song is simply not in it,
  // and the list opens at the top with nothing playing. Derived rather than
  // corrected — an effect that fixed this up afterwards would render one frame
  // of the previous query's cursor over this query's rows.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const active = Math.max(
    0,
    results.findIndex((r) => r.id === activeId),
  );
  const playing = results.some((r) => r.id === playingId) ? playingId : null;
  const setActive = (index: number) => setActiveId(results[index]?.id ?? null);

  // The keyboard drives this from the input above, which keeps focus, so the
  // handler lives on the document rather than on the list.
  useEffect(() => {
    if (!results.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = active + (event.key === "ArrowDown" ? 1 : -1);
        setActiveId(results[(next + results.length) % results.length]?.id ?? null);
      } else if (event.key === "Enter") {
        const track = results[active];
        if (track) {
          event.preventDefault();
          onPick(track);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [results, active, onPick]);

  useEffect(() => {
    list.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (state.status === "idle") return null;

  return (
    <div className="nt-search-panel" role="listbox" aria-label={`${SERVICES[service].label} results`}>
      {state.status === "searching" && <div className="nt-search-note">Searching…</div>}
      {state.status === "unconfigured" && (
        <div className="nt-search-note">
          Spotify search needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET. Apple
          Music works without either, or paste a link.
        </div>
      )}
      {state.status === "failed" && (
        <div className="nt-search-note">{SERVICES[service].label} didn’t answer. Try again.</div>
      )}
      {state.status === "results" && !results.length && (
        <div className="nt-search-note">Nothing found.</div>
      )}

      <div ref={list} className="nt-search-rows">
        {results.map((track, index) =>
          playing === track.id && !track.preview ? (
            // Spotify's preview IS the player, so it stands in for its row.
            <div key={track.id} className="nt-search-row is-embed">
              <Preview track={track} service={service} />
              <button
                type="button"
                className="nt-search-use"
                onClick={() => onPick(track)}
              >
                Use this
              </button>
            </div>
          ) : (
            <div
              key={track.id}
              role="option"
              aria-selected={index === active}
              data-active={index === active}
              className="nt-search-row"
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(track)}
            >
              <button
                type="button"
                className="nt-search-play"
                aria-label={playing === track.id ? "Stop preview" : `Preview ${track.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setPlayingId(playing === track.id ? null : track.id);
                }}
              >
                {/* A 36px cover straight from the service's own CDN. next/image
                    would want every music CDN in the remote allow-list, to
                    resize what is already thumbnail-sized. */}
                {track.artwork && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={track.artwork} alt="" className="nt-search-art" />
                )}
                <span className="nt-search-glyph">
                  {playing === track.id ? (
                    <Pause width={13} height={13} />
                  ) : (
                    <Play width={13} height={13} />
                  )}
                </span>
              </button>
              <span className="nt-search-title">{track.title}</span>
              <span className="nt-search-artist">{track.artist}</span>
              <span className="nt-search-time">{duration(track.durationMs)}</span>
              {playing === track.id && track.preview && (
                <Preview track={track} service={service} />
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
