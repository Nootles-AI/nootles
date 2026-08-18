"use client";

import { useConvex } from "convex/react";
import { useRef, useState } from "react";
import { put } from "../album/upload";
import { CheckRow, PanelSection } from "../canvas/panels/controls/PanelSection";
import type { ActiveLocation } from "./shell";
import { PARTS, type Location, type Part } from "./types";

/**
 * What to show of a place.
 *
 * Wears the style panel's own clothes — same rail, same sections, same check
 * rows — because it is the same idea: the thing under the hand, described on
 * the right. The name has no checkbox because a card without one is not a
 * card; it gets a field instead, since the only thing to decide about a name
 * is what it says.
 *
 * Pictures are listed one per row rather than as a grid of thumbnails: what is
 * being chosen here is which few of them the card carries, and that reads as a
 * list of decisions, not as a gallery.
 */

const LABELS: Record<Part, string> = {
  map: "Map",
  address: "Address",
  rating: "Rating",
  photos: "Photos",
  note: "Description",
  link: "Google Maps link",
};

/** What a part would show if it were ticked — an unticked empty row is a lie. */
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
    default:
      return true;
  }
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
      off: PARTS.filter((p) =>
        p === part ? !on : location.off.includes(p),
      ),
    });

  const toggleImage = (src: string, on: boolean) =>
    set({
      ...location,
      images: location.images.map((image) =>
        image.src === src ? { src, ...(on ? {} : { off: true })} : image,
      ),
    });

  async function add(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    setAdding(true);
    try {
      const src = await put(convex, file, file.type);
      set({ ...location, images: [...location.images, { src }] });
    } catch {
      // Nothing to say here that the empty row does not already say.
    } finally {
      setAdding(false);
    }
  }

  return (
    <aside className="nt-style-panel" aria-label="Location">
      <div className="nt-section-label nt-style-panel-head">
        <span>Location</span>
      </div>
      <div className="nt-style-panel-body">
        <PanelSection title="Name">
          <div className="nt-ctl-row">
            <input
              className="nt-loc-field"
              value={location.name}
              aria-label="Place name"
              onChange={(event) => set({ ...location, name: event.target.value })}
            />
          </div>
        </PanelSection>

        <PanelSection title="Show">
          {PARTS.map((part) => (
            <CheckRow
              key={part}
              label={LABELS[part]}
              on={!location.off.includes(part) && present(location, part)}
              onChange={(on) => toggle(part, on)}
            />
          ))}
          {/* Off by default and its own decision: ticking it asks the reader's
              browser where they are. */}
          <CheckRow
            label="Drive time from here"
            on={Boolean(location.drive)}
            onChange={(on) => set({ ...location, drive: on || undefined })}
          />
        </PanelSection>

        <PanelSection
          title="Pictures"
          onAdd={() => picker.current?.click()}
          addLabel="Add a picture"
        >
          {location.images.length === 0 && (
            <div className="nt-ctl-note">
              {adding ? "Adding…" : "None yet — add one of your own."}
            </div>
          )}
          {location.images.map((image, index) => (
            <CheckRow
              key={image.src}
              label={`Picture ${index + 1}`}
              on={!image.off}
              onChange={(on) => toggleImage(image.src, on)}
            />
          ))}
          {adding && location.images.length > 0 && (
            <div className="nt-ctl-note">Adding…</div>
          )}
          <input
            ref={picker}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            className="nt-loc-picker"
            onChange={(event) => {
              void add(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </PanelSection>
      </div>
    </aside>
  );
}
