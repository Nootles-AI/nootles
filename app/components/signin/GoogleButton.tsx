"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { GoogleMark } from "../GoogleMark";

/**
 * The way in, and the only control on the door.
 *
 * Google is the only way in, so this is one button rather than a form. Built
 * headless instead of with Clerk's prebuilt component: the surface is neutral by
 * design and the accent belongs to AI activity, which a vendor stylesheet has no
 * way to know.
 *
 * Driven through `client.signIn` rather than `useSignIn`, which in this version
 * returns the newer signals resource. That one wants the whole transfer ladder
 * spelled out in the callback; this pairs with `AuthenticateWithRedirectCallback`,
 * which already knows how to turn a first-time Google user into an account —
 * which is also why there is no line under the button explaining that signing in
 * makes an account. Nobody was ever going to be surprised by that.
 */
export function GoogleButton({
  redirectTo = "/",
  compact,
}: {
  /** Where the round trip lands — a share link passes itself, so the page
      that asked for the sign-in is the page that finishes the job. */
  redirectTo?: string;
  /** The modal fit: full width, no door margins. */
  compact?: boolean;
} = {}) {
  const { isLoaded } = useAuth();
  const clerk = useClerk();
  const [failed, setFailed] = useState(false);
  const [going, setGoing] = useState(false);

  const start = async () => {
    if (!isLoaded || going) return;
    setFailed(false);
    setGoing(true);
    try {
      await clerk.client.signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        // The destination rides the callback URL too: `redirectUrlComplete`
        // covers plain sign-in, but a first-time account goes through the
        // sign-up transfer, and only the callback page's own props steer that
        // leg (see sso-callback/page.tsx).
        redirectUrl:
          redirectTo === "/"
            ? "/sso-callback"
            : `/sso-callback?return=${encodeURIComponent(redirectTo)}`,
        redirectUrlComplete: redirectTo,
      });
    } catch {
      // The redirect never happened, so this is still mounted to say so.
      setFailed(true);
      setGoing(false);
    }
  };

  return (
    <>
      <button
        onClick={start}
        disabled={!isLoaded || going}
        aria-busy={going}
        className={`nt-si-go${compact ? " is-compact" : ""}`}
      >
        <GoogleMark width={16} height={16} />
        {going ? "Taking you to Google…" : "Continue with Google"}
      </button>

      {/*
        Empty at rest and never removed: `aria-live` announces a change to a
        region that was already in the document, so a line that mounts along
        with its message is announced by nothing. Its room is held for the same
        reason — the one moment this has anything to say is the moment the user
        is watching for whether anything happened.
      */}
      <p aria-live="polite" className="nt-si-status">
        {failed ? "That didn’t go through. Try again." : ""}
      </p>

      {/*
        The press above forms an agreement, and it only binds if it says so
        where the press happens — which is also why this lives with the button
        rather than on the door: the sign-in-to-edit modal is a door too. The
        second sentence is the disclosure instrumentation-client.ts has always
        claimed was made at signup; as of this line, it is.
      */}
      <p className="nt-si-legal">
        By continuing you agree to the{" "}
        <a
          href="https://www.nootles.com/terms"
          target="_blank"
          rel="noopener noreferrer"
        >
          Terms of Service
        </a>{" "}
        and acknowledge the{" "}
        <a
          href="https://www.nootles.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
        >
          Privacy Policy
        </a>
        . Nootles is in beta: sessions are recorded, and your work with the AI
        trains the models.
      </p>
    </>
  );
}
