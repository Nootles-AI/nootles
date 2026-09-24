"use client";

import { useEffect, useState } from "react";

/** How long a row that has gone stays drawn: `.is-leaving`'s fade. */
const LEAVE_MS = 220;

/**
 * A list's rows, with any that have just gone from it kept a moment longer,
 * marked leaving, where they were — so a person removed or a domain taken off
 * fades out of the list rather than vanishing from it in a frame, whoever
 * removed it. Rows are told apart by `keyOf`, so a list rebuilt each render is
 * the same list while it holds the same rows.
 */
export function useLeaving<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): { item: T; leaving: boolean }[] {
  const keys = items.map(keyOf).join("\n");
  const [prev, setPrev] = useState({ keys, items });
  const [gone, setGone] = useState<{ item: T; at: number }[]>([]);
  if (keys !== prev.keys) {
    const here = new Set(items.map(keyOf));
    const left = prev.items.flatMap((item, at) => (here.has(keyOf(item)) ? [] : [{ item, at }]));
    // Under reduced motion too: the fade is what says it went.
    setGone((was) => [...was.filter((g) => !here.has(keyOf(g.item))), ...left]);
    setPrev({ keys, items });
  }

  useEffect(() => {
    if (!gone.length) return;
    const timer = setTimeout(() => setGone([]), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [gone]);

  const rows = items.map((item) => ({ item, leaving: false }));
  for (const { item, at } of [...gone].sort((a, b) => a.at - b.at)) {
    rows.splice(Math.min(at, rows.length), 0, { item, leaving: true });
  }
  return rows;
}
