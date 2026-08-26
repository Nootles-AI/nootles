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
 * `fallback` is what stands in meanwhile, and it matters more than it sounds:
 * this gate is the FIRST thing in the tree, so whatever it renders is what the
 * server puts in the HTML and what the browser paints before Clerk has even
 * loaded. A route that passes nothing gets a blank sheet for as long as that
 * takes — which on a cold workspace load was over a second of white screen.
 */
export function Authed({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <>
      <AuthLoading>{fallback ?? <div className="flex-1" aria-busy="true" />}</AuthLoading>
      <Authenticated>{children}</Authenticated>
    </>
  );
}
