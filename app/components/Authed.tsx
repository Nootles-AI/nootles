"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useConnection } from "@/app/ConvexClientProvider";
import { Interrupted } from "./Interrupted";
import { useStandIn } from "./StandIn";

/**
 * How long a lost session goes unsaid. Signing out here, or switching
 * workspace, passes through "no identity" on its way somewhere else; neither
 * should flash a notice first.
 */
const SETTLE_MS = 300;

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
 *
 * A surface already up stays up while Clerk is slow to hand over a token:
 * Convex keeps the identity it had, and the provider says it is reconnecting
 * over the page. It is taken down only once Convex has let the identity go,
 * because from then on every query under it answers as nobody.
 */
export function Authed({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const connection = useConnection();
  const placeholder = fallback ?? <div className="flex-1" aria-busy="true" />;
  return (
    <>
      <AuthLoading>
        {/* Asking again is a load too, but one that can run as long as an
            outage does: it says what it is doing rather than going blank. */}
        {connection === "live" ? placeholder : <Reconnecting stuck={connection === "stuck"} />}
      </AuthLoading>
      <Authenticated>{children}</Authenticated>
      <Unauthenticated>
        <SignedOutHere placeholder={placeholder} />
      </Unauthenticated>
    </>
  );
}

/**
 * `proxy.ts` turns a signed-out request around before it gets here, so this
 * is a session that ended mid-visit: Convex lost the token while Clerk still
 * holds one (the provider is already asking again), Clerk's session itself
 * ended — signed out in another tab — or an operator's stand-in token stopped
 * being honoured. A reload is the way back from the first two: after a
 * sign-out it lands on sign-in, which returns here.
 */
function SignedOutHere({ placeholder }: { placeholder: ReactNode }) {
  const { isSignedIn } = useAuth();
  const standIn = useStandIn();
  const connection = useConnection();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!settled) return placeholder;
  // Nothing asks again for a stand-in: its token is the one it was given.
  if (standIn) {
    return (
      <Interrupted title="This stand-in session has ended">
        Its token is no longer accepted. End it from the banner to return to your own account.
      </Interrupted>
    );
  }
  if (isSignedIn) return <Reconnecting stuck={connection === "stuck"} />;
  return (
    <Interrupted title="You’ve been signed out">
      Your session ended, perhaps in another tab. Reload to sign in again and come back here.
    </Interrupted>
  );
}

function Reconnecting({ stuck }: { stuck: boolean }) {
  return stuck ? (
    <Interrupted title="Can’t reconnect">
      Nootles can’t get your account back on its own. It will try again when you come back to
      this tab; a reload usually settles it.
    </Interrupted>
  ) : (
    <Interrupted title="Reconnecting…" busy>
      Nootles lost its connection to your account for a moment and is getting it back.
    </Interrupted>
  );
}
