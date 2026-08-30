"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Entitlement, Meter } from "@/convex/entitlements";

/**
 * What this account may do, live.
 *
 * A plain hook rather than a context: Convex dedupes identical subscriptions,
 * so ten components asking is one query and one socket update. Which is the
 * whole point — the moment a code is redeemed or a checkout lands, every wall
 * in the app opens without anything having to be told to refetch.
 *
 * Nothing here is a security boundary. Every meter is enforced again in Convex
 * and in the API routes; this only decides what to DRAW, which is why it errs
 * open: while the answer is still arriving, `room` is true, and a slow query
 * never flashes a paywall at somebody who has paid.
 */
export function usePlan() {
  // `undefined` is still arriving; `null` is nobody signed in — a share-link
  // visitor, or the moment before Clerk resolves. Neither is an account with a
  // spent allowance, and both must draw exactly like an account with room.
  const entitlement = useQuery(api.entitlements.mine, {}) as
    | Entitlement
    | null
    | undefined;

  const room = useCallback(
    (meter: Meter): boolean =>
      !entitlement || entitlement.left === null || entitlement.left[meter] > 0,
    [entitlement],
  );

  return useMemo(
    () => ({
      entitlement,
      /** Undefined until there is an answer — never gate on a value you lack. */
      pro: entitlement ? entitlement.plan === "pro" : undefined,
      left: entitlement?.left ?? null,
      room,
    }),
    [entitlement, room],
  );
}
