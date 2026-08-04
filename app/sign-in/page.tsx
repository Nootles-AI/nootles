"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { LogoStacked } from "../components/Brand";
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
 * The one screen that is allowed to be the brand rather than the product. It is
 * all a signed-out person ever sees, there is no document on it to compete with,
 * and it is the only page whose job is to say whose software this is — so the
 * logo is the page and the paper is tinted a step toward it. Both stop at the
 * door: past this, surfaces are neutral and the only colour means AI.
 *
 * Centred, unlike the rest of the app, because there is nothing else here to
 * align to. Still three groups separated by space alone — who this is, the way
 * in, and the footnote — and the button stays neutral, because a green button
 * beside Google's mark reads as a second brand asking for the same click.
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
    // Sits a little above true centre: a block centred by measurement reads as
    // low, and this one has all its weight at the top.
    <main className="nt-signin flex flex-1 items-center justify-center px-6 pb-[10vh]">
      <div className="w-full max-w-[19rem] text-center">
        {/* The name, drawn rather than set — so `h1` carries it for anything
            reading the page, and the mark carries it for anyone looking. */}
        <h1>
          <LogoStacked
            role="img"
            aria-label="Nootles"
            className="mx-auto text-brand"
          />
        </h1>
        <p className="mt-6 text-[13px] leading-relaxed text-muted">
          Notes, diagrams and maths on one page, with an AI that works in it
          alongside you.
        </p>

        <button
          onClick={start}
          disabled={!isLoaded || going}
          aria-busy={going}
          className="nt-row mt-9 h-9 w-full justify-center gap-2 border bg-background font-medium"
          style={{ borderColor: "var(--border-strong)" }}
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
