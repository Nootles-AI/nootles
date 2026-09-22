"use client";

import { useEffect, useMemo, useRef } from "react";

/**
 * Debounced persistence for a block whose surface owns its live state.
 *
 * CodeMirror's text, a MathLive row, a storyboard's shots: each is held locally
 * and written into the document after a pause, so typing stays O(1) instead of
 * rewriting the block's whole value into ProseMirror per keystroke.
 *
 * One implementation because there were three, and they had drifted: two of
 * them cleared the pending timer on unmount without running it, so the last
 * keystrokes before a page switch were dropped. The flush the cleanup owes is
 * part of the bargain, not something each block remembers on its own — and so
 * is telling a write coming home from an outside change, which is the other
 * half every one of the three had to solve.
 */

/**
 * A value, or the way to get it — deferred so a value that costs work to build
 * is built once at the flush rather than once per keystroke. A storyboard's
 * value is its whole board serialized, every shot's drawing included.
 */
export type Persistable = string | (() => string);

export type DebouncedPersist = {
  /** Write after the quiet time; a later call replaces what is pending. */
  schedule: (value: Persistable) => void;
  /** Write at once, dropping anything pending. */
  write: (value: Persistable) => void;
  /** Write what is pending, if anything is. */
  flush: () => void;
  /**
   * Take `value` as what the document holds, dropping anything pending. For a
   * surface sent back to the document after a refusal it only learned of
   * later — the write was booked as made, and is not in the document.
   */
  adopt: (value: string) => void;
};

export function useDebouncedPersist(
  /** Writes the value into the document. `false` means the document refused it. */
  persist: (value: string) => void | boolean,
  delayMs: number,
  /** The block's current value, watched for changes that are not ours. */
  incoming: string,
  /**
   * An outside change to reconcile: an AI op, another synced tab, an undo.
   * Whatever was pending is dropped before it runs — the surface is about to
   * replace the local state that write was going to carry.
   */
  onExternal?: (value: string) => void,
): DebouncedPersist {
  const persistRef = useRef(persist);
  const externalRef = useRef(onExternal);
  useEffect(() => {
    persistRef.current = persist;
    externalRef.current = onExternal;
  });

  const last = useRef(incoming);
  const pending = useRef<Persistable | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const api = useMemo((): DebouncedPersist => {
    const stop = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    };
    // A write that reproduces the last one says nothing, and every one of them
    // is a CRDT update each collaborator has to download.
    const put = (value: Persistable) => {
      const s = typeof value === "string" ? value : value();
      if (s === last.current) return;
      const held = last.current;
      last.current = s;
      // A refused write never reached the document. Booking it as written would
      // leave the next outside change looking like our own echo, and the value
      // the surface is still showing would never be reconciled away.
      if (persistRef.current(s) === false) last.current = held;
    };
    const flush = () => {
      const value = pending.current;
      stop();
      if (value !== null) put(value);
    };
    return {
      schedule: (value: Persistable) => {
        stop();
        pending.current = value;
        timer.current = setTimeout(flush, delayMs);
      },
      write: (value: Persistable) => {
        stop();
        put(value);
      },
      flush,
      adopt: (value: string) => {
        stop();
        last.current = value;
      },
    };
  }, [delayMs]);

  useEffect(() => {
    if (incoming === last.current) return;
    api.adopt(incoming);
    externalRef.current?.(incoming);
  }, [incoming, api]);

  // The last write, on the way out — and tolerant, because a block can be
  // unmounting for having been DELETED, and BlockNote throws on a write into a
  // block that is no longer there. There is nowhere for that value to land.
  useEffect(
    () => () => {
      try {
        api.flush();
      } catch {}
    },
    [api],
  );

  return api;
}
