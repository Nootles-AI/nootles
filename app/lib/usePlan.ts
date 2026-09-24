"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Entitlement, Meter } from "@/convex/entitlements";
import { guestDaySpent } from "@/convex/plans";

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
 *
 * Inside a project, pass it: the walls there are the allowance that governs
 * work in that project (`entitlements.forContainer`) — a workspace's in a
 * workspace project the caller writes in, their own anywhere else — so a
 * member whose own free allowance is spent is not walled in the team's
 * projects. Without one it is the account's own, which is what the account
 * menu's plan line and the paywall itself speak about.
 */
export function usePlan(projectId?: Id<"projects"> | null) {
  // `undefined` is still arriving; `null` is nobody signed in — a share-link
  // visitor, or the moment before Clerk resolves. Neither is an account with a
  // spent allowance, and both must draw exactly like an account with room.
  const standing = useQuery(api.entitlements.forContainer, projectId ? { projectId } : {});
  const entitlement: Entitlement | null | undefined =
    standing === undefined ? undefined : (standing?.entitlement ?? null);

  const room = useCallback(
    (meter: Meter): boolean =>
      !entitlement || entitlement.left === null || entitlement.left[meter] > 0,
    [entitlement],
  );

  const guestAi = standing?.guestAi ?? null;
  /** A guest's day of the workspace's AI is spent — asked at the moment of asking. */
  const guestSpent = useCallback(() => guestDaySpent(guestAi, Date.now()), [guestAi]);

  return useMemo(
    () => ({
      entitlement,
      /** Undefined until there is an answer — never gate on a value you lack. */
      pro: entitlement ? entitlement.plan === "pro" : undefined,
      left: entitlement?.left ?? null,
      room,
      guestSpent,
    }),
    [entitlement, room, guestSpent],
  );
}

/**
 * Whether a Convex call was refused by the plan (`quotaRefusal` in
 * `convex/entitlements.ts`), for the walls that are raised by the server's
 * answer rather than drawn ahead of it. Read off the error's data here, so the
 * browser does not import the server module that defines it.
 */
export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    (error.data as { code?: unknown }).code === "quota"
  );
}
