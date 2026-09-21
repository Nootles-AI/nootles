"use client";

import { useEffect, useState } from "react";

/**
 * Keeps a surface mounted for `exitMs` after it closes, so CSS can play an exit
 * off `data-state="closed"`. A timer rather than `animationend`, because a menu
 * with staggered rows ends many animations and only the last one means "gone".
 */
export function usePresence(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, mounted, exitMs]);

  return { mounted, state: open ? "open" : "closed" } as const;
}
