"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { GoogleMark } from "../components/GoogleMark";

/**
 * Google is the only way in, so this is one button rather than a form. Built
 * headless instead of with Clerk's prebuilt component: the surface is neutral by
 * design and the accent belongs to AI activity, which a vendor stylesheet has no
 * way to know.
 *
 * Driven through `client.signIn` rather than `useSignIn`, which in this version
 * returns the newer signals resource. That one wants the whole transfer ladder
 * spelled out in the callback; this pairs with `AuthenticateWithRedirectCallback`,
 * which already knows how to turn a first-time Google user into an account.
 *
 * Three groups separated by space alone — who this is, the way in, and the
 * footnote. Nothing here is doing hierarchy with colour or a rule.
 */
export default function SignInPage() {
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
    // Sits a little above true centre: a block of text centred by measurement
    // reads as low, and this one has all its weight at the top.
    <main className="flex flex-1 items-center justify-center px-6 pb-[10vh]">
      <div className="w-full max-w-[19rem]">
        <h1 className="text-[length:var(--text-title)] font-semibold tracking-[-0.02em]">
          Nootles
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Notes, diagrams and maths on one page, with an AI that works in it
          alongside you.
        </p>

        <button
          onClick={start}
          disabled={!isLoaded || going}
          aria-busy={going}
          className="nt-row mt-9 h-9 w-full justify-center gap-2 border bg-sunken font-medium"
          style={{ borderColor: "var(--border)" }}
        >
          <GoogleMark width={16} height={16} />
          {going ? "Taking you to Google…" : "Continue with Google"}
        </button>

        {/*
          One region rather than a message that appears and shoves the page
          down, and `aria-live` rather than a `role` that switches to "alert"
          only once it has something to say — a live region has to be in the
          document before the text lands for the change to be announced.
        */}
        <p
          aria-live="polite"
          className="mt-3 min-h-8 text-[length:var(--text-meta-lg)] leading-relaxed text-muted"
        >
          {failed ? (
            <span className="text-danger">
              That didn’t go through. Try again.
            </span>
          ) : (
            "New here? Signing in creates your account."
          )}
        </p>
      </div>
    </main>
  );
}
