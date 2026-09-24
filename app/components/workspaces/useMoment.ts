"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * True for a moment after `flash()` — how long a “Copied” or a “Saved” stays
 * up before it goes back to what it was. Flashing again restarts the moment.
 */
export function useMoment(ms = 1600): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash];
}
