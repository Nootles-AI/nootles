import { useEffect, useState } from "react";

/**
 * True while `on`, and for `ms` after it stops being — long enough for whatever
 * is leaving to be seen leaving. A timer rather than `transitionend`, which a
 * background tab or a reduced-motion setting may never deliver.
 */
export function useLinger(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  if (on && !held) setHeld(true);

  useEffect(() => {
    if (on || !held) return;
    const t = setTimeout(() => setHeld(false), ms);
    return () => clearTimeout(t);
  }, [on, held, ms]);

  return on || held;
}
