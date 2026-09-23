"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { impersonationToken } from "@/app/lib/impersonation";
import { useStandIn } from "./StandIn";

/** Undefined while this session's address is still being confirmed. */
const ConfirmedContext = createContext<string | null | undefined>(undefined);

/**
 * How long a tab goes before coming back to it asks again. A session outlives
 * the server's day-old re-check, and an address it has not re-checked in a
 * few days admits nobody.
 */
const REASK_MS = 60 * 60 * 1000;

/**
 * The address the server confirmed for this session, null for none, or
 * undefined while it is still asking. A surface that would tell someone their
 * address is missing or wrong waits for this first: on a first visit the
 * confirmation lands a moment after the page does.
 */
export function useConfirmedEmail(): string | null | undefined {
  return useContext(ConfirmedContext);
}

/**
 * Asks the server to confirm who this session is (`identity.sync`) when a
 * signed-in session starts, and again when the tab comes back into view an
 * hour or more later. Clerk's session token names only the account, so the
 * address that invitations and join domains are bound to comes from the
 * server's own word with Clerk, never from this tab.
 *
 * Not for an operator standing in: the server refuses them, and their session
 * has nothing of its own to confirm.
 */
export function IdentitySync({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const { sessionId } = useAuth();
  const standIn = useStandIn();
  const sync = useAction(api.identity.sync);
  const asked = useRef<{ session: string; at: number } | null>(null);
  const [answer, setAnswer] = useState<{ session: string; email: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (!isAuthenticated || !sessionId || impersonationToken()) return;
    const ask = () => {
      const first = asked.current?.session !== sessionId;
      asked.current = { session: sessionId, at: Date.now() };
      const settle = (email: string | null) => setAnswer({ session: sessionId, email });
      // A failed re-ask keeps the answer already given.
      sync({}).then(settle, () => {
        if (first) settle(null);
      });
    };
    if (asked.current?.session !== sessionId) ask();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - (asked.current?.at ?? 0) >= REASK_MS) ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isAuthenticated, sessionId, sync]);

  const confirmed = standIn
    ? null
    : answer && answer.session === sessionId
      ? answer.email
      : undefined;
  return <ConfirmedContext value={confirmed}>{children}</ConfirmedContext>;
}
