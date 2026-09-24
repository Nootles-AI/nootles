"use client";

import { useSyncExternalStore } from "react";
import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { seenSeat } from "@/app/lib/projectsCache";

const noop = () => () => {};

/**
 * What the account's own settings are called: "Settings", as they always
 * were, until a workspace's settings are on offer too — then "Account
 * settings", so the two are told apart. A guest is offered no workspace's
 * settings (`SettingsFrame`), so a guest's seat changes nothing.
 *
 * Until the seats answer, the name is the one this browser last had reason
 * for, so a member does not watch the word arrive.
 */
export function useAccountSettingsName(ask = true): string {
  const { isAuthenticated } = useConvexAuth();
  const { userId } = useAuth();
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const seats = useQuery(api.workspaces.listMine, ask && isAuthenticated ? {} : "skip");
  const both = seats
    ? seats.some((seat) => seat.role !== "guest")
    : hydrated && !!userId && seenSeat(userId);
  return both ? "Account settings" : "Settings";
}
