"use client";

import { useEffect, useState } from "react";
import { peekIntent, type BillingIntent } from "./intent";

/**
 * What the person was doing when they were stopped, safe to render.
 *
 * `sessionStorage` cannot be read while rendering: the server has no answer, so
 * a value read during the first render disagrees with the HTML the server sent
 * and the surface hydrates wrong — which here would mean the sentence naming
 * the way back flickering into place under someone already reading it.
 *
 * So the first render says "nothing waiting", and the note arrives immediately
 * after. This is the one-time external-store read the project sanctions
 * set-state-in-effect for, the same shape as the layout restore on the projects
 * screen — it is not a value derived from props.
 */
export function useWaitingIntent(): {
  intent: BillingIntent;
  from: string;
} | null {
  const [waiting, setWaiting] = useState<{
    intent: BillingIntent;
    from: string;
  } | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const stored = peekIntent();
    if (stored) setWaiting({ intent: stored.intent, from: stored.from });
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return waiting;
}
