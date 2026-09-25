"use client";

import { useEffect, useMemo, useRef } from "react";

/** How long the pointer rests on something before what it opens is worth loading. */
const DWELL_MS = 50;

/**
 * Runs a warm-up once the pointer has rested on its target, so a sweep across
 * a list on the way somewhere else does not fan out into loads.
 */
export function useDwell() {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useMemo(
    () => ({
      enter(warm: () => void) {
        clearTimeout(timer.current);
        timer.current = setTimeout(warm, DWELL_MS);
      },
      leave() {
        clearTimeout(timer.current);
      },
    }),
    [],
  );
}
