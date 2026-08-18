"use client";

import { useConvex } from "convex/react";
import { useRef, useState } from "react";
import { Check } from "../../Icons";
import { put } from "../album/upload";
import { CheckRow, PanelSection } from "../canvas/panels/controls/PanelSection";
import type { ActiveLocation } from "./shell";
import { isGoogle, PARTS, type Location, type LocationImage, type Part } from "./types";

/**
 * What to show of a place.
 *
 * Wears the style panel's own clothes — same rail, same sections, same check
 * rows — because it is the same idea: the thing under the hand, described on
 * the right. The name has no checkbox because a card without one is not a
 * card; it gets a field, and so does the description, since the only thing to
 * decide about words is what they say.
 *
 * A part with nothing behind it is not offered. An unticked "Rating" on a place
 * that has no rating reads as something switched off, when the truth is there
 * was never anything there — and ticking it would show nothing.
 */

const LABELS: Record<Part, string> = {
  map: "Map",
  address: "Address",
  rating: "Rating and reviews",
  photos: "Photos",
  note: "Description",
  drive: "Drive time from here",
  link: "Google Maps link",
};

/** What a part would show if it were ticked. */
function present(location: Location, part: Part): boolean {
  switch (part) {
    case "address":
      return Boolean(location.address);
    case "rating":
      return location.rating !== undefined;
    case "photos":
      return location.images.length > 0;
    case "note":
      return Boolean(location.note);
    case "map":
      return Boolean(location.name || location.at);
    default:
      return true;
  }
}

function Pictures({
  title,
  images,
  onToggle,
}: {
  title: string;
  images: LocationImage[];
  onToggle: (src: string, on: boolean) => void;
}) {
  if (!images.length) return null;
  return (
    <>
      <div className="nt-ctl-sublabel">{title}</div>
      <div className="nt-loc-grid">
        {images.map((image) => (
          <button
            key={image.src}
            type="button"
            role="checkbox"
            aria-checked={!image.off}
            aria-label={`Show this picture`}
            className={`nt-loc-thumb${image.off ? "" : " is-on"}`}
            onClick={() => onToggle(image.src, Boolean(image.off))}
          >
            {/* Straight from the service's own CDN through our proxy, already
                thumbnail-sized; next/image would resize what is already small. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.src} alt="" />
            <span className="nt-loc-tick" aria-hidden>
              <Check width={11} height={11} />
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

export function LocationPanel({ active }: { active: ActiveLocation }) {
  const { location, set } = active;
  const convex = useConvex();
  const picker = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);

  const toggle = (part: Part, on: boolean) =>
    set({
      ...location,
      // Kept in the vocabulary's order rather than the order they were
      // clicked, so the card's text does not churn as boxes are ticked.
      off: PARTS.filter((p) => (p === part ? !on : location.off.includes(p))),
    });

  const toggleImage = (src: string, on: boolean) =>
    set({
      ...location,
      images: location.images.map((image) =>
        image.src === src ? { src, ...(on ? {} : { off: true }) } : image,
      ),
    });

  async function add(files: FileList | null) {
    const chosen = [...(files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!chosen.length) return;
    setAdding(true);
    try {
      const added = await Promise.all(
        chosen.map(async (file) => ({ src: await put(convex, file, file.type) })),
      );
      set({ ...location, images: [...location.images, ...added] });
    } catch {
      // Nothing to say here that the unchanged grid does not already say.
    } finally {
      setAdding(false);
    }
  }

  const mine = location.images.filter((image) => !isGoogle(image));
  const theirs = location.images.filter(isGoogle);

  return (
    <aside className="nt-style-panel" aria-label="Location">
      <div className="nt-section-label nt-style-panel-head">
        <span>Location</span>
      </div>
      <div className="nt-style-panel-body">
        <PanelSection title="Place">
          <div className="nt-ctl-group">
            <input
              className="nt-loc-field"
              value={location.name}
              placeholder="Name"
              aria-label="Place name"
              onChange={(event) => set({ ...location, name: event.target.value })}
            />
            <textarea
              className="nt-loc-field nt-loc-area"
              value={location.note ?? ""}
              placeholder="Why this place, in your words"
              aria-label="Description"
              rows={3}
              onChange={(event) =>
                set({ ...location, note: event.target.value || undefined })
              }
            />
          </div>
        </PanelSection>

        <PanelSection title="Show">
          {PARTS.filter((part) => present(location, part)).map((part) => (
            <CheckRow
              key={part}
              label={LABELS[part]}
              on={!location.off.includes(part)}
              onChange={(on) => toggle(part, on)}
            />
          ))}
        </PanelSection>

        <PanelSection
          title="Pictures"
          onAdd={() => picker.current?.click()}
          addLabel="Add a picture"
        >
          {!location.images.length && !adding && (
            <div className="nt-ctl-note">None yet — add one of your own.</div>
          )}
          {adding && <div className="nt-ctl-note">Adding…</div>}
          <Pictures title="Yours" images={mine} onToggle={toggleImage} />
          <Pictures title="From Google" images={theirs} onToggle={toggleImage} />
          <input
            ref={picker}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            multiple
            className="nt-loc-picker"
            onChange={(event) => {
              void add(event.target.files);
              event.target.value = "";
            }}
          />
        </PanelSection>
      </div>
    </aside>
  );
}
