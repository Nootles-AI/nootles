"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { seenScreen } from "@/app/lib/projectsCache";

const noop = () => () => {};

/**
 * Sends a brand new account to the welcome screen, and nobody else.
 *
 * "New" is deliberately two conditions rather than one. A missing profile row
 * on its own would also describe every account that existed before first run
 * did — and dropping those people into a survey, projects and all, would be
 * the worst possible greeting. An empty project list is what distinguishes
 * them, and it stops being true the moment either flow finishes. A seat in a
 * workspace counts as having projects too: someone whose work is all in a
 * team's workspaces has a place to be, and it isn't a survey.
 *
 * Renders nothing while the answer is unknown. The project list asked for is
 * the very query the projects screen draws from (`listForScreen`, not the
 * plainer `list`), so the screen mounts onto an answer already in the client
 * instead of spending a second round trip asking after this gate has opened.
 *
 * One visitor's answer is known before anything is asked: a browser that has
 * drawn this account's projects before (`projectsCache`) is not looking at a
 * new account. Those go straight through, ahead of Convex's token, and the
 * screen draws what it last saw while the live lists arrive. That is why this
 * waits on Convex itself rather than sitting under `Authed` — the screen has to
 * keep one place in the tree from its cached paint to its live one, or it
 * would mount twice and arrive twice.
 */
export function FirstRun({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const { userId } = useAuth();
  // False on the server and through hydration, so what storage holds cannot
  // make the first client render disagree with the server's.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  const known = hydrated && !!userId && seenScreen(userId) !== null;

  const profile = useQuery(api.profiles.get, isAuthenticated ? {} : "skip");
  const projects = useQuery(api.projects.listForScreen, isAuthenticated ? {} : "skip");
  const workspaces = useQuery(api.workspaces.listMine, isAuthenticated ? {} : "skip");

  const fresh = profile === null && projects?.length === 0 && workspaces?.length === 0;

  useEffect(() => {
    if (fresh) router.replace("/welcome");
  }, [fresh, router]);

  if (
    fresh ||
    (!known && (profile === undefined || projects === undefined || workspaces === undefined))
  ) {
    return <div className="flex-1" aria-busy="true" />;
  }
  return <>{children}</>;
}
