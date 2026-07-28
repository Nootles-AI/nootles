"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a media query. `useSyncExternalStore` rather than an effect:
 * the match is external state we read, not derived state we set, so there's no
 * set-state-in-effect and no flash of the wrong layout.
 *
 * The server snapshot is always `false`, so SSR renders the desktop layout and
 * hydration matches; narrow viewports correct on the first client read.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
