"use client";

import { useEffect, useState } from "react";
import { classify } from "./link";

/**
 * Whether a media link points at something that is really there.
 *
 * Asked once per URL per tab and remembered, so a page of songs costs one
 * question each and a re-render costs none. `unknown` is the resting state and
 * the safe one: a player is only ever taken away by a provider saying plainly
 * that the thing is gone, never by a slow network, a rate limit, or a provider
 * we cannot ask (see `app/api/media/verify`).
 */

export type Verdict = "unknown" | "ok" | "missing";

const known = new Map<string, Verdict>();
const asking = new Map<string, Promise<Verdict>>();

/** Only these can come back `missing`; the rest are never worth a request. */
function checkable(url: string): boolean {
  const kind = classify(url)?.kind;
  return kind === "spotify" || kind === "youtube" || kind === "soundcloud";
}

function ask(url: string): Promise<Verdict> {
  const inFlight = asking.get(url);
  if (inFlight) return inFlight;
  const request = fetch(`/api/media/verify?url=${encodeURIComponent(url)}`)
    .then((res) => (res.ok ? res.json() : { status: "unknown" }))
    .then((body: { status?: Verdict }) => body.status ?? "unknown")
    .catch((): Verdict => "unknown")
    .then((verdict) => {
      known.set(url, verdict);
      asking.delete(url);
      return verdict;
    });
  asking.set(url, request);
  return request;
}

export function useVerified(url: string): Verdict {
  const [, bump] = useState(0);
  const settled = known.get(url);

  useEffect(() => {
    if (!url || !checkable(url) || known.has(url)) return;
    let live = true;
    void ask(url).then(() => {
      if (live) bump((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [url]);

  return settled ?? "unknown";
}
