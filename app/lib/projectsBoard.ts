"use client";

import { useSyncExternalStore } from "react";

export type Point = { x: number; y: number };

/**
 * Where the board is panned to, and where each project has been put. A project
 * with no entry has never been moved, and is placed by the board instead.
 *
 * Kept beside `nt:projectsView`, in this browser: it is how someone has
 * arranged their own front door, the same kind of fact as which view they left
 * it in. Nothing about a project changes when its frame moves.
 */
export type BoardLayout = { pan: Point; at: Record<string, Point> };

const KEY = "nt:projectsBoard";
const EMPTY: BoardLayout = { pan: { x: 0, y: 0 }, at: {} };

// `getSnapshot` has to hand back the same object until the stored string
// changes, or every render looks like a change and React loops.
let raw: string | null = null;
let parsed = EMPTY;

function read(): BoardLayout {
  const now = localStorage.getItem(KEY);
  if (now === raw) return parsed;
  raw = now;
  try {
    parsed = now ? { ...EMPTY, ...(JSON.parse(now) as Partial<BoardLayout>) } : EMPTY;
  } catch {
    parsed = EMPTY;
  }
  return parsed;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function writeBoard(change: (layout: BoardLayout) => BoardLayout) {
  const next = change(read());
  if (next === EMPTY) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((listener) => listener());
}

export const resetBoard = () => writeBoard(() => EMPTY);

export function useBoardLayout(): BoardLayout {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
