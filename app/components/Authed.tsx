"use client";

import type { ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useReconnecting } from "@/app/ConvexClientProvider";
import { Interrupted } from "./Interrupted";

/**
 * Holds a surface back until Convex has the caller's token.
 *
 * Without this the owner-scoped queries run once while the client is still
 * anonymous and answer null — which the page reads as "does not exist" and says
 * so, a second before the real document arrives.
 *
 * Renders nothing while it waits, unless given the surface's own skeleton
 * (`fallback`): the window is a few hundred milliseconds, but a page that owns
 * its whole screen would otherwise pass through a white one.
 */
export function Authed({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  // Asking Convex again is a load too, but one that can run as long as an
  // outage does: it keeps saying what it is doing rather than going blank.
  const reconnecting = useReconnecting();
  return (
    <>
      <AuthLoading>
        {reconnecting ? <SignedOutHere /> : (fallback ?? <div className="flex-1" aria-busy="true" />)}
      </AuthLoading>
      <Authenticated>{children}</Authenticated>
      <Unauthenticated>
        <SignedOutHere />
      </Unauthenticated>
    </>
  );
}

/**
 * `proxy.ts` turns a signed-out request around before it gets here, so this
 * is a session that ended mid-visit: Convex lost the token while Clerk still
 * holds one (the provider is already asking again), or Clerk's session itself
 * ended — signed out in another tab. A reload is the way back from either;
 * the second lands on sign-in and returns here.
 */
function SignedOutHere() {
  const { isSignedIn } = useAuth();
  return isSignedIn ? (
    <Interrupted title="Reconnecting…" busy>
      Nootles lost its connection to your account for a moment and is getting it back.
    </Interrupted>
  ) : (
    <Interrupted title="You’ve been signed out">
      Your session ended, perhaps in another tab. Reload to sign in again and come back here.
    </Interrupted>
  );
}
