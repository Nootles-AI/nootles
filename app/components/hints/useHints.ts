"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * The first-touch hints' one piece of state: which lessons are already learned.
 *
 * A hint is alive until the thing it teaches has demonstrably been done once,
 * and then it is dead forever — recorded on the profile so it stays dead
 * across devices. There are no dismiss buttons anywhere; doing the thing is
 * the dismissal.
 */
export function useHints() {
  const profile = useQuery(api.profiles.get, {});
  /**
   * Optimistic, because a hint's death is usually the frame the user succeeds
   * in — a drag, a Tab — and waiting a round trip to stop whispering about the
   * thing they just did reads as the app not noticing.
   */
  const seen = useMutation(api.profiles.seen).withOptimisticUpdate(
    (store, args) => {
      const p = store.getQuery(api.profiles.get, {});
      if (!p || p.hints?.includes(args.id)) return;
      store.setQuery(api.profiles.get, {}, {
        ...p,
        hints: [...(p.hints ?? []), args.id],
      });
    },
  );

  const alive = useCallback(
    (id: string): boolean =>
      profile?.status === "touring" && !(profile.hints ?? []).includes(id),
    [profile],
  );
  const die = useCallback(
    (id: string) => void seen({ id }).catch(() => {}),
    [seen],
  );

  return useMemo(() => ({ profile, alive, die }), [profile, alive, die]);
}
