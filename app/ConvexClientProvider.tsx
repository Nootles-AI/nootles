"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConvexReactClient, ConvexProviderWithAuth, useConvexAuth } from "convex/react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { impersonationToken } from "./lib/impersonation";
import { forgetOnSignOut } from "./lib/projectsCache";
import { requireConvexDeploymentUrl } from "./lib/convexDeploymentUrl";
import { patientToken, reauthDelay } from "./lib/sessionToken";

const convex = new ConvexReactClient(
  requireConvexDeploymentUrl(process.env.NEXT_PUBLIC_CONVEX_URL),
);

/**
 * The operator's stand-in token, if any, and how many times this tab has
 * asked Convex to take a token again (`Reauthenticate`).
 */
const Session = createContext<{ standIn: string | null; asked: number }>({
  standIn: null,
  asked: 0,
});

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
  const { standIn, asked } = useContext(Session);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (standIn) return standIn;
      // The dashboard's Convex integration puts `aud: "convex"` on the raw
      // session token; the template is the fallback for instances without it.
      return patientToken(() =>
        sessionClaims?.aud === "convex"
          ? getToken({ skipCache: forceRefreshToken })
          : getToken({ template: "convex", skipCache: forceRefreshToken }),
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
 * Asks Convex to take a token again when it has let go of the one Clerk still
 * holds. Convex gives up on an identity for good the first time a refresh
 * comes back empty, and nothing but a new token function makes it ask again —
 * without this, a tab that lost one refresh to the network stayed signed out
 * of every query, drawing nothing, until it was reloaded.
 */
function Reauthenticate({ again }: { again: () => void }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { isSignedIn } = useAuth();
  const dropped = isSignedIn === true && !isLoading && !isAuthenticated;
  const tries = useRef(0);

  useEffect(() => {
    if (isAuthenticated) tries.current = 0;
    if (!dropped) return;
    const ask = () => {
      tries.current++;
      again();
    };
    const timer = window.setTimeout(ask, reauthDelay(tries.current));
    // Back online, or back in front of someone: no reason to sit out a delay.
    const now = () => {
      if (!navigator.onLine || document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      ask();
    };
    window.addEventListener("online", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [dropped, isAuthenticated, again]);

  return null;
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
  const session = useMemo(() => ({ standIn, asked }), [standIn, asked]);
  return (
    <Session value={session}>
      <ConvexProviderWithAuth client={convex} useAuth={useNootlesAuth}>
        {!standIn && <Reauthenticate again={again} />}
        {children}
      </ConvexProviderWithAuth>
    </Session>
  );
}
