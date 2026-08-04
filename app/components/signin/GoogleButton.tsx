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
export function GoogleButton() {
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
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/",
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
        className="nt-si-go"
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
    </>
  );
}
