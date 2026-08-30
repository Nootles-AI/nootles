"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  endImpersonation,
  expiryOf,
  impersonationToken,
} from "@/app/lib/impersonation";

/**
 * Whether this tab is an operator standing in for a user, and the banner that
 * says so.
 *
 * The server is what enforces read-only (`convex/auth.ts`); this is the part
 * that keeps the app from OFFERING what it is about to refuse — the controls
 * that exist for everyone, like "New project", which no project role gates.
 * Inside a project the demotion in `projects.myRole` already does that work.
 */
const StandInContext = createContext(false);

/** True when the account on screen is not the one signed in. */
export function useStandIn(): boolean {
  return useContext(StandInContext);
}

export function StandInProvider({ children }: { children: React.ReactNode }) {
  // The cookie is browser-only, so the ordinary tree renders first — SSR and
  // the first client render agree — and the stand-in is adopted on mount. Same
  // sanctioned shape as Workspace's layout restore.
  /* eslint-disable react-hooks/set-state-in-effect */
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => setToken(impersonationToken()), []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <StandInContext value={!!token}>
      {children}
      {token && <Banner token={token} />}
    </StandInContext>
  );
}

/**
 * The standing reminder that this is not your account.
 *
 * Inverted rather than coloured: the app's one accent is amber and already
 * means "a guest could be editing this", which is close enough to be worth not
 * saying twice. Black on white says something else entirely, and an operator
 * session is the one screen that must never be mistaken for an ordinary one.
 */
function Banner({ token }: { token: string }) {
  const who = useQuery(api.impersonation.current, {});
  const [remaining, setRemaining] = useState(() => expiryOf(token) - Date.now());

  // The token is dead either way; clearing the cookie is what stops the next
  // load from booting into a session that can no longer read.
  const end = useCallback(() => {
    endImpersonation();
    location.replace("/");
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const left = expiryOf(token) - Date.now();
      setRemaining(left);
      if (left <= 0) end();
    }, 1000);
    return () => clearInterval(id);
  }, [token, end]);

  return (
    <div className="nt-imp" role="status">
      <span className="nt-imp-dot" aria-hidden />
      <span>
        Viewing as <strong>{who?.email ?? who?.name ?? who?.subject ?? "…"}</strong> —
        read-only
      </span>
      <span className="nt-imp-left">{Math.max(0, Math.ceil(remaining / 60000))}m left</span>
      <button className="nt-imp-end" onClick={end}>
        End
      </button>
    </div>
  );
}
