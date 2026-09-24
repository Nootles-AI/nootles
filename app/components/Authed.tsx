"use client";

import type { ReactNode } from "react";
import { Authenticated, AuthLoading } from "convex/react";

/**
 * Holds a surface back until Convex has the caller's token.
 *
 * Without this the owner-scoped queries run once while the client is still
 * anonymous and answer null — which the page reads as "does not exist" and says
 * so, a second before the real document arrives. There is no unauthenticated
 * branch because `proxy.ts` turns those requests around before they get here.
 *
 * Renders nothing while it waits, unless given the surface's own skeleton
 * (`fallback`): the window is a few hundred milliseconds, but a page that owns
 * its whole screen would otherwise pass through a white one.
 */
export function Authed({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <>
      <AuthLoading>{fallback ?? <div className="flex-1" aria-busy="true" />}</AuthLoading>
      <Authenticated>{children}</Authenticated>
    </>
  );
}
