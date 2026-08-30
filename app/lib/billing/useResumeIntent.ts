"use client";

import { useEffect, useRef } from "react";
import { takeArmedIntent, type BillingIntent, type IntentKind } from "./intent";

/**
 * Picks up the action the wall interrupted, once the screen that owns it can
 * actually perform it.
 *
 * `ready` is not a convenience: the chat panel cannot send until a thread and a
 * transport exist, and replaying into a half-built screen loses the message
 * silently — which is the one outcome worse than making the person retype it.
 *
 * The intent is consumed as it is read, so this fires once. That is load-bearing
 * for `chatSend`, where a second firing is a second model call and a second
 * charge against an allowance the person has just paid to stop worrying about.
 */
export function useResumeIntent<K extends IntentKind>(
  kind: K,
  ready: boolean,
  run: (intent: Extract<BillingIntent, { kind: K }>) => void,
): void {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });

  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    const intent = takeArmedIntent(kind);
    if (!intent) return;
    done.current = true;
    latest.current(intent);
  }, [ready, kind]);
}
