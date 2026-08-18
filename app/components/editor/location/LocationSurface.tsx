"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LinkIcon, Search } from "../../Icons";
import { useReadOnly } from "../readOnly";
import { embedUrl, isMapsUrl, isShortMapsUrl, linkUrl, parseMapsUrl } from "./maps";
import { parseLocation } from "./parse";
import { serializeLocation } from "./serialize";
import { fromHit, useDriveTime, usePlaceSearch } from "./places";
import { useLocationShell } from "./shell";
import { emptyLocation, showing, shown, type Location } from "./types";
import "./location.css";

/**
 * A place, as a card.
 *
 * The card is assembled from whatever is known and nothing else: a place with
 * no rating shows no stars, one nobody has photographed shows no strip. What
 * the reader chose to hide is honoured on top of that — the panel switches
 * parts off, it does not invent them.
 *
 * A pasted Google Maps link is enough to build one, with no key anywhere: the
 * link carries the name, the map frames from the same URL, and the outward
 * link is the one Google asks to be linked with. Searching by words, the
 * photographs and the rating are what a key adds.
 */

function Stars({ rating }: { rating: number }) {
  // Drawn as one clipped row rather than five glyphs: a 4.5 is half a star, and
  // five separate glyphs cannot say that without rounding it away.
  const filled = Math.max(0, Math.min(5, rating)) / 5;
  return (
    <span className="nt-loc-stars" aria-label={`${rating} out of 5`}>
      <span className="nt-loc-stars-off">★★★★★</span>
      <span className="nt-loc-stars-on" style={{ width: `${filled * 100}%` }}>
        ★★★★★
      </span>
    </span>
  );
}

export function LocationSurface({
  blockId,
  source,
  onChange,
}: {
  blockId: string;
  source: string;
  onChange: (markup: string) => void;
}) {
  const readOnly = useReadOnly();
  const shell = useLocationShell();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const location = useMemo(() => parseLocation(source), [source]);
  const has = Boolean(location.name || location.at);

  // The block hands down a fresh closure every render, and this identity ends
  // up in the shell — so it is pinned behind a ref that an effect keeps
  // current. Without that, republishing below would hand the workspace a new
  // object forever and the two would re-render each other without stopping.
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const set = useCallback(
    (next: Location) => latest.current(serializeLocation(next)),
    [],
  );

  // The panel belongs to the card under the hand. Claimed on the way down and
  // on pointer rather than focus: the block holds no editable content, so a
  // text cursor can never land in it.
  const mine = shell.active?.blockId === blockId;
  const claim = () => {
    if (!readOnly && has) shell.set({ blockId, location, set });
  };
  // The panel edits what the card says NOW, so a card that changes under it
  // republishes — but only when it has actually changed, which is what keeps
  // this from being a loop.
  useEffect(() => {
    const active = shell.active;
    if (!mine || !active) return;
    if (active.location === location && active.set === set) return;
    shell.set({ blockId, location, set });
  }, [mine, blockId, location, set, shell]);
  // Withdrawing has to happen on the way OUT and only then. Reaching for the
  // shell directly here would tie this to an object that changes on every
  // selection, and its cleanup would then run mid-life and clear the very
  // selection it was meant to outlast — which is exactly what it did.
  const shellRef = useRef(shell);
  useEffect(() => {
    shellRef.current = shell;
  });
  useEffect(
    () => () => {
      const current = shellRef.current;
      if (current.active?.blockId === blockId) current.set(null);
    },
    [blockId],
  );

  const drive = useDriveTime(location, Boolean(location.drive) && has);
  const search = usePlaceSearch(draft, !has && !isMapsUrl(draft));

  async function commit(text: string) {
    const raw = text.trim();
    if (!raw) return;
    setBusy(true);
    try {
      // A short link says nothing until it is followed, and only the server
      // can follow it.
      let link = raw;
      if (isShortMapsUrl(raw)) {
        const res = await fetch(`/api/places?mode=resolve&url=${encodeURIComponent(raw)}`);
        const body = (await res.json()) as { resolved?: string };
        if (body.resolved) link = body.resolved;
      }
      const read = parseMapsUrl(link);
      if (!read) return;
      set({
        ...emptyLocation(read.name ?? read.query ?? "Dropped pin"),
        ...(read.at ? { at: read.at } : {}),
        ...(read.place ? { place: read.place } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!has) {
    if (readOnly) return null;
    return (
      <div className="nt-loc nt-loc-empty">
        <div className="nt-loc-drop">
          <Search width={15} height={15} />
          <input
            className="nt-loc-input"
            placeholder="Paste a Google Maps link, or search a place…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (isMapsUrl(text)) {
                event.preventDefault();
                setDraft(text);
                void commit(text);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isMapsUrl(draft)) void commit(draft);
            }}
          />
          {busy && <span className="nt-loc-busy">Looking…</span>}
        </div>

        {search.status !== "idle" && (
          <div className="nt-loc-results" role="listbox" aria-label="Places">
            {search.status === "searching" && <div className="nt-loc-note">Searching…</div>}
            {search.status === "unconfigured" && (
              <div className="nt-loc-note">
                Searching places needs GOOGLE_MAPS_API_KEY. Pasting a Google Maps
                link works without it.
              </div>
            )}
            {search.status === "failed" && (
              <div className="nt-loc-note">Google didn’t answer. Try again.</div>
            )}
            {search.status === "results" &&
              (search.places.length ? (
                search.places.map((hit) => (
                  <button
                    key={hit.place}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="nt-loc-hit"
                    onClick={() => set(fromHit(hit))}
                  >
                    <span className="nt-loc-hit-name">{hit.name}</span>
                    {hit.rating !== undefined && (
                      <span className="nt-loc-hit-rating">{hit.rating.toFixed(1)} ★</span>
                    )}
                    <span className="nt-loc-hit-address">{hit.address}</span>
                  </button>
                ))
              ) : (
                <div className="nt-loc-note">Nothing found.</div>
              ))}
          </div>
        )}
      </div>
    );
  }

  const pictures = shown(location);
  const map = showing(location, "map") ? embedUrl(location) : "";

  return (
    <div
      className={`nt-loc${mine ? " is-active" : ""}`}
      onPointerDownCapture={claim}
      onFocus={claim}
    >
      {map && (
        <div className="nt-loc-map-wrap">
          <iframe
            className="nt-loc-map"
            src={map}
            title={`Map of ${location.name}`}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
          {/* A frame swallows the press that would have chosen this card, so
              an unchosen map is behind glass: the first click picks the card
              up, and once it is the one being edited the map is live and can
              be dragged. */}
          {!mine && !readOnly && (
            <button
              type="button"
              className="nt-loc-shield"
              aria-label={`Select ${location.name}`}
              onClick={claim}
            />
          )}
        </div>
      )}

      <div className="nt-loc-body">
        <div className="nt-loc-head">
          <span className="nt-loc-name">{location.name}</span>
          {showing(location, "rating") && location.rating !== undefined && (
            <span className="nt-loc-rating">
              <Stars rating={location.rating} />
              <span className="nt-loc-score">{location.rating.toFixed(1)}</span>
              {location.votes !== undefined && (
                <span className="nt-loc-votes">({location.votes.toLocaleString()})</span>
              )}
            </span>
          )}
        </div>

        {showing(location, "address") && location.address && (
          <div className="nt-loc-address">{location.address}</div>
        )}

        {showing(location, "note") && location.note && (
          <div className="nt-loc-note-text">{location.note}</div>
        )}

        {showing(location, "photos") && pictures.length > 0 && (
          <div className="nt-loc-photos">
            {/* Google's photo bytes come through our own proxy, already sized
                for this strip; next/image would want Google's CDN in the remote
                allow-list to resize what we asked for at the right size. */}
            {pictures.map((picture) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={picture.src} src={picture.src} alt="" className="nt-loc-photo" />
            ))}
          </div>
        )}

        <div className="nt-loc-foot">
          {showing(location, "link") && (
            <a
              className="nt-loc-link"
              href={linkUrl(location)}
              target="_blank"
              rel="noreferrer"
            >
              <LinkIcon width={13} height={13} />
              Google Maps
            </a>
          )}
          {drive && <span className="nt-loc-drive">{drive} away</span>}
        </div>
      </div>
    </div>
  );
}
