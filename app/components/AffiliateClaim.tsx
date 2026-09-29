"use client";

import { useEffect, useRef } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { clearedRefCookie, refToClaim } from "@/app/lib/affiliateRef";
import { impersonationToken } from "@/app/lib/impersonation";
import { withAnalytics } from "@/app/lib/telemetry";

/**
 * Claims a signed-in account for the affiliate whose link brought it, from
 * the `nt_ref` cookie `/r/<slug>` left (`affiliates.attribute`), then forgets
 * the cookie. Renders nothing.
 *
 * Here, on every route, rather than in `FirstRun`: someone who arrives
 * through a share link may never see the welcome screen. The server decides
 * everything — whether the account is new enough, whether the link is live —
 * so any answer at all settles the cookie; only a call that never got one
 * leaves it for the next load. Not for an operator standing in, whom the
 * server would refuse, and whose cookie is their own.
 */
export function AffiliateClaim() {
  const { isAuthenticated } = useConvexAuth();
  const attribute = useMutation(api.affiliates.attribute);
  const asked = useRef<string | null>(null);

  useEffect(() => {
    const ref = refToClaim(document.cookie, {
      authenticated: isAuthenticated,
      standingIn: impersonationToken() !== null,
    });
    if (!ref || asked.current === ref) return;
    asked.current = ref;
    attribute({ ref }).then(
      ({ affiliate }) => {
        document.cookie = clearedRefCookie(location.protocol === "https:");
        // `$set_once`, so the first affiliate a person is tagged with stays.
        if (affiliate) {
          withAnalytics((posthog) => posthog.setPersonProperties(undefined, { affiliate }));
        }
      },
      // Kept for the next load; the client has already logged why.
      () => {},
    );
  }, [isAuthenticated, attribute]);

  return null;
}
