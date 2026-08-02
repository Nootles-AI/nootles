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
 * Renders nothing while it waits: this window is a few hundred milliseconds, and
 * the surfaces underneath already have skeletons of their own.
 */
export function Authed({ children }: { children: ReactNode }) {
  return (
    <>
      <AuthLoading>
        <div className="flex-1" aria-busy="true" />
      </AuthLoading>
      <Authenticated>{children}</Authenticated>
    </>
  );
}
