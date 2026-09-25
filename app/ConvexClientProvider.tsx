"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ConvexReactClient, ConvexProviderWithAuth, useConvexAuth } from "convex/react";
import { useAuth, useClerk } from "@clerk/nextjs";
import * as Sentry from "@sentry/nextjs";
import { impersonationToken } from "./lib/impersonation";
import { forgetOnSignOut } from "./lib/projectsCache";
import { requireConvexDeploymentUrl } from "./lib/convexDeploymentUrl";
import { patientToken, reauthDelay, reauthState } from "./lib/sessionToken";

const convex = new ConvexReactClient(
  requireConvexDeploymentUrl(process.env.NEXT_PUBLIC_CONVEX_URL),
);

/**
 * The operator's stand-in token, if any; how many times this tab has asked
 * Convex to take a token again (`Reauthenticate`); and how the token fetch
 * says it is waiting on Clerk.
 */
const Session = createContext<{
  standIn: string | null;
  asked: number;
  onWait: (waiting: boolean) => void;
}>({ standIn: null, asked: 0, onWait: () => {} });

/**
 * Which identity this tab speaks to Convex as.
 *
 * Normally Clerk's — this is `ConvexProviderWithClerk` unrolled, so the token
 * path is the same one it would have taken. What it adds is the operator stand-in
 * (see `/impersonate`), whose own short-lived token wins for as long as it is
 * live. The swap can only ever widen what is READ: the server refuses every
 * write made under that token, and it says so in `convex/auth.ts`.
 */
function useNootlesAuth() {
  const { isLoaded, isSignedIn, getToken, orgId, orgRole, sessionId, sessionClaims } =
    useAuth();
  const clerk = useClerk();
  const { standIn, asked, onWait } = useContext(Session);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (standIn) return standIn;
      // The dashboard's Convex integration puts `aud: "convex"` on the raw
      // session token; the template is the fallback for instances without it.
      return patientToken(
        () =>
          sessionClaims?.aud === "convex"
            ? getToken({ skipCache: forceRefreshToken })
            : getToken({ template: "convex", skipCache: forceRefreshToken }),
        { signedIn: () => clerk.isSignedIn, onWait },
      );
    },
    // Clerk's contract: a new function identity is what re-authenticates the
    // client, so anything the token's contents depend on belongs here — and
    // `asked`, which exists only to be that new identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [standIn, orgId, orgRole, sessionId, asked],
  );

  return useMemo(
    () =>
      standIn
        ? // No round trip to make and nothing to wait for: the token is already
          // in hand, and expiry is the banner's business, not the provider's.
          { isLoading: false, isAuthenticated: true, fetchAccessToken }
        : {
            isLoading: !isLoaded,
            isAuthenticated: isSignedIn ?? false,
            fetchAccessToken,
          },
    [standIn, isLoaded, isSignedIn, fetchAccessToken],
  );
}

/**
 * How this tab's hold on Convex stands, past simply having it:
 * - `waiting` — Clerk has not handed over a token yet; Convex still has the
 *   last identity, and the tab carries on offline.
 * - `reasking` — Convex let go of the identity and is being asked to take it again.
 * - `stuck` — it has refused enough times that only a reload is worth offering.
 */
export type Connection = "live" | "waiting" | "reasking" | "stuck";

const ConnectionContext = createContext<Connection>("live");

export function useConnection(): Connection {
  return useContext(ConnectionContext);
}

/**
 * Asks Convex to take a token again when it has let go of the one Clerk still
 * holds. Convex gives up on an identity for good the first time a refresh
 * comes back empty, and nothing but a new token function makes it ask again —
 * without this, a tab that lost one refresh to the network stayed signed out
 * of every query, drawing nothing, until it was reloaded.
 */
function Reauthenticate({
  asked,
  again,
  waiting,
  children,
}: {
  asked: number;
  again: () => void;
  waiting: boolean;
  children: ReactNode;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isSignedIn } = useAuth();
  const [held, setHeld] = useState(asked);
  const { held: since, tries, dropped, stuck } = reauthState({
    asked,
    held,
    isSignedIn,
    isLoading,
    isAuthenticated,
  });
  if (since !== held) setHeld(since);

  useEffect(() => {
    if (!dropped) return;
    // Refused this often, the answer is the server's: stop asking on a clock,
    // but a return to the network or to the tab is still worth one more try.
    const timer = stuck ? undefined : window.setTimeout(again, reauthDelay(tries));
    const now = () => {
      if (!navigator.onLine || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      again();
    };
    window.addEventListener("online", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [dropped, stuck, tries, again]);

  useEffect(() => {
    if (!stuck) return;
    Sentry.captureMessage("Convex keeps refusing a token Clerk still issues", {
      level: "warning",
      tags: { feature: "reauth" },
      extra: { tries, online: navigator.onLine },
    });
    // Once per outage: `stuck` stays true through the asks that follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stuck]);

  const connection: Connection = stuck
    ? "stuck"
    : tries > 0 && !isAuthenticated
      ? "reasking"
      : waiting
        ? "waiting"
        : "live";

  return (
    <ConnectionContext value={connection}>
      {children}
      {connection === "waiting" && isAuthenticated && (
        <div className="nt-update" role="status">
          <span>Reconnecting… your changes sync once it’s back.</span>
        </div>
      )}
    </ConnectionContext>
  );
}

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  // Here rather than on the projects screen, because this is the one place
  // mounted on every route: signing out from inside a project has to clear
  // what the screen cached just as surely as signing out from the screen.
  const clerk = useClerk();
  useEffect(() => forgetOnSignOut(clerk), [clerk]);
  // Read once, at mount. `/impersonate` hard-navigates after setting the
  // cookie, so it never changes under a tree that is already up — and holding
  // it in state keeps every render answering the same identity.
  const [standIn] = useState(impersonationToken);
  const [asked, setAsked] = useState(0);
  const again = useCallback(() => setAsked((n) => n + 1), []);
  // A count, not a flag: a scheduled refresh and a re-ask after the server's
  // refusal can both be waiting on Clerk at once.
  const [waits, setWaits] = useState(0);
  const onWait = useCallback((w: boolean) => setWaits((n) => n + (w ? 1 : -1)), []);
  const session = useMemo(() => ({ standIn, asked, onWait }), [standIn, asked, onWait]);
  return (
    <Session value={session}>
      <ConvexProviderWithAuth client={convex} useAuth={useNootlesAuth}>
        {standIn ? (
          children
        ) : (
          <Reauthenticate asked={asked} again={again} waiting={waits > 0}>
            {children}
          </Reauthenticate>
        )}
      </ConvexProviderWithAuth>
    </Session>
  );
}
