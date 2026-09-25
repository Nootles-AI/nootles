"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { DEFAULT_REACH, clampReach } from "@/app/lib/ai/reach";

/**
 * The account's autocomplete: whether it runs and how far it reaches.
 *
 * Optimistic, because both are answered by the page the moment they change —
 * a toggle that waits a round trip to light reads as a missed click, and a
 * slider that snaps back mid-drag is worse.
 */
export function useAutocomplete() {
  const profile = useQuery(api.profiles.get, {});
  const write = useMutation(api.profiles.setAutocomplete).withOptimisticUpdate(
    (store, args) => {
      const p = store.getQuery(api.profiles.get, {});
      if (!p) return;
      store.setQuery(api.profiles.get, {}, {
        ...p,
        ...(args.on !== undefined && { autocomplete: args.on }),
        ...(args.reach !== undefined && { autocompleteReach: clampReach(args.reach) }),
      });
    },
  );

  const on = profile?.autocomplete ?? true;
  const reach = profile?.autocompleteReach ?? DEFAULT_REACH;
  const setOn = useCallback((next: boolean) => void write({ on: next }).catch(() => {}), [write]);
  const setReach = useCallback(
    (next: number) => void write({ reach: next }).catch(() => {}),
    [write],
  );

  return useMemo(
    () => ({ loaded: profile !== undefined, on, reach, setOn, setReach }),
    [profile, on, reach, setOn, setReach],
  );
}
