import { useEffect, useSyncExternalStore } from "react";

/**
 * Which new diagrams are offering their presets: the ones the slash menu just
 * made, until one is chosen, the offer is closed, a shape arrives some other
 * way, or the block goes. Held in memory only — an offer is a moment, never
 * part of the page, and leaving the page ends it.
 */

const offered = new Set<string>();
const mounted = new Map<string, number>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

export function offerPresets(blockId: string): void {
  if (offered.has(blockId)) return;
  offered.add(blockId);
  emit();
}

export function withdrawPresets(blockId: string): void {
  if (offered.delete(blockId)) emit();
}

export function presetsOffered(blockId: string): boolean {
  return offered.has(blockId);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * Whether this diagram's block is offering presets. The offer ends with the
 * block's last view, a task later — a remount (StrictMode's, a node view
 * redrawn) is the same block staying, not one going.
 */
export function usePresetOffer(blockId: string): boolean {
  useEffect(() => {
    mounted.set(blockId, (mounted.get(blockId) ?? 0) + 1);
    return () => {
      const left = (mounted.get(blockId) ?? 1) - 1;
      if (left > 0) return void mounted.set(blockId, left);
      mounted.delete(blockId);
      setTimeout(() => {
        if (!mounted.has(blockId)) withdrawPresets(blockId);
      }, 0);
    };
  }, [blockId]);
  return useSyncExternalStore(
    subscribe,
    () => offered.has(blockId),
    () => false,
  );
}
