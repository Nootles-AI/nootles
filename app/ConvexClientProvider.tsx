"use client";

import { ReactNode, useCallback, useMemo, useState } from "react";
import { ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { impersonationToken } from "./lib/impersonation";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

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
  // Read once, at mount. `/impersonate` hard-navigates after setting the
  // cookie, so it never changes under a tree that is already up — and holding
  // it in state keeps every render answering the same identity.
  const [standIn] = useState(impersonationToken);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (standIn) return standIn;
      try {
        // The dashboard's Convex integration puts `aud: "convex"` on the raw
        // session token; the template is the fallback for instances without it.
        return sessionClaims?.aud === "convex"
          ? await getToken({ skipCache: forceRefreshToken })
          : await getToken({ template: "convex", skipCache: forceRefreshToken });
      } catch {
        return null;
      }
    },
    // Clerk's contract: a new function identity is what re-authenticates the
    // client, so anything the token's contents depend on belongs here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [standIn, orgId, orgRole, sessionId],
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

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useNootlesAuth}>
      {children}
    </ConvexProviderWithAuth>
  );
}
