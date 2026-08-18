"use client";

import { useEffect, useState } from "react";
import type { Found, Service } from "./types";

export type { Service };

/**
 * Searching a service, from the block's own row.
 *
 * The query is debounced and every answer is kept, so backspacing through a
 * word costs nothing and the list never flickers back through states the
 * typist has already left behind.
 */

export const SERVICES: Record<Service, { label: string; brand: string }> = {
  apple: { label: "Apple Music", brand: "#fa2d48" },
  spotify: { label: "Spotify", brand: "#1db954" },
};

export type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "results"; results: Found[] }
  | { status: "unconfigured" }
  | { status: "failed" };

/** Long enough that a fast typist makes one request, short enough to feel live. */
const DEBOUNCE_MS = 250;

const answers = new Map<string, SearchState>();

export function useSearch(service: Service | null, query: string): SearchState {
  const trimmed = query.trim();
  const key = service ? `${service}:${trimmed.toLowerCase()}` : "";
  const [, bump] = useState(0);

  useEffect(() => {
    if (!service || trimmed.length < 2 || answers.has(key)) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      let state: SearchState;
      try {
        const res = await fetch(
          `/api/media/search?provider=${service}&q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        const body = (await res.json()) as
          | { results: Found[] }
          | { configured: false };
        state =
          "configured" in body
            ? { status: "unconfigured" }
            : { status: "results", results: body.results };
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
        state = { status: "failed" };
      }
      answers.set(key, state);
      bump((n) => n + 1);
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [service, trimmed, key]);

  if (!service || trimmed.length < 2) return { status: "idle" };
  return answers.get(key) ?? { status: "searching" };
}

/**
 * Which service a block should open searching, set by `/spotify` and
 * `/apple music` on their way past.
 *
 * A module note rather than a block prop: what the block HOLDS is a song, and
 * how it was opened is not part of that. Written into the document it would
 * outlive the moment, reach the AI grammar, and have to be serialized by every
 * reader of a page for no one's benefit.
 */
const armed = new Map<string, Service>();

export function armBlock(blockId: string, service: Service) {
  armed.set(blockId, service);
}

/** Read once, by the block itself, and forgotten. */
export function takeArm(blockId: string): Service | null {
  const service = armed.get(blockId);
  if (service) armed.delete(blockId);
  return service ?? null;
}
