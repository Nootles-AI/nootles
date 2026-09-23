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
 * The address the server confirmed for this session, null for none, or
 * undefined while it is still asking. A surface that would tell someone their
 * address is missing or wrong waits for this first: on a first visit the
 * confirmation lands a moment after the page does.
 */
export function useConfirmedEmail(): string | null | undefined {
  return useContext(ConfirmedContext);
}

/**
 * Asks the server to confirm who this session is (`identity.sync`) once per
 * signed-in session. Clerk's session token names only the account, so the
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
  const asked = useRef<string | null>(null);
  const [answer, setAnswer] = useState<{ session: string; email: string | null } | null>(
    null,
  );

  useEffect(() => {
    if (!isAuthenticated || !sessionId || asked.current === sessionId) return;
    if (impersonationToken()) return;
    asked.current = sessionId;
    const settle = (email: string | null) => setAnswer({ session: sessionId, email });
    sync({}).then(settle, () => settle(null));
  }, [isAuthenticated, sessionId, sync]);

  const confirmed = standIn
    ? null
    : answer && answer.session === sessionId
      ? answer.email
      : undefined;
  return <ConfirmedContext value={confirmed}>{children}</ConfirmedContext>;
}
