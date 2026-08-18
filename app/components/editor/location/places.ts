"use client";

import { useEffect, useState } from "react";
import { mapQuery } from "./maps";
import type { Location, PlaceHit } from "./types";

/**
 * Asking Google the things a pasted link cannot answer.
 *
 * Every state here has an honest resting place: `unconfigured` when this
 * deployment has no key, which is not an error and is said in words the reader
 * can act on, and `failed` when Google was asked and did not answer. The card
 * itself never depends on any of it.
 */

export type PlacesState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "results"; places: PlaceHit[] }
  | { status: "unconfigured" }
  | { status: "failed" };

const DEBOUNCE_MS = 300;
const answers = new Map<string, PlacesState>();

export function usePlaceSearch(query: string, live: boolean): PlacesState {
  const trimmed = query.trim();
  const [, bump] = useState(0);

  useEffect(() => {
    if (!live || trimmed.length < 3 || answers.has(trimmed)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      let state: PlacesState;
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        const body = (await res.json()) as
          | { places: PlaceHit[] }
          | { configured: false }
          | { error: string };
        state =
          "configured" in body
            ? { status: "unconfigured" }
            : "places" in body
              ? { status: "results", places: body.places }
              : { status: "failed" };
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
        state = { status: "failed" };
      }
      answers.set(trimmed, state);
      bump((n) => n + 1);
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [trimmed, live]);

  if (!live || trimmed.length < 3) return { status: "idle" };
  return answers.get(trimmed) ?? { status: "searching" };
}

/**
 * How long it takes to drive there from where the reader is.
 *
 * Asked only when the card is showing it, because answering means asking the
 * browser where the reader is — and that prompt should follow a checkbox
 * somebody ticked, never the mere opening of a page.
 */
const drives = new Map<string, string>();

export function useDriveTime(location: Location, wanted: boolean): string | null {
  const to = mapQuery(location);
  const [answer, setAnswer] = useState<string | null>(() => drives.get(to) ?? null);

  useEffect(() => {
    if (!wanted || !to || drives.has(to) || !navigator.geolocation) return;
    let live = true;
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const from = `${position.coords.latitude},${position.coords.longitude}`;
        try {
          const res = await fetch(
            `/api/places?mode=drive&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          );
          const body = (await res.json()) as { drive?: string };
          if (body.drive) {
            drives.set(to, body.drive);
            if (live) setAnswer(body.drive);
          }
        } catch {
          // A drive time nobody could work out is a line the card leaves out.
        }
      },
      // Refused permission is an answer too, and the card simply says nothing.
      () => {},
      { maximumAge: 5 * 60 * 1000, timeout: 8000 },
    );
    return () => {
      live = false;
    };
  }, [to, wanted]);

  return wanted ? (drives.get(to) ?? answer) : null;
}

/** Fill a card from a place Google knows, keeping what the user already chose. */
export function fromHit(hit: PlaceHit, existing?: Location): Location {
  return {
    ...(existing ?? { images: [], off: [] }),
    name: hit.name,
    ...(hit.address ? { address: hit.address } : {}),
    ...(hit.at ? { at: hit.at } : {}),
    place: hit.place,
    ...(hit.rating !== undefined ? { rating: hit.rating } : {}),
    ...(hit.votes !== undefined ? { votes: hit.votes } : {}),
    images: hit.photos.map((src, index) => ({
      src,
      // Two is a card; six is a contact sheet. The rest are kept, unticked, so
      // the panel can offer them without another trip to Google.
      ...(index < 2 ? {} : { off: true as const }),
    })),
    off: existing?.off ?? [],
  };
}
