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
 */
export default function SignInPage() {
  const { isLoaded } = useAuth();
  const clerk = useClerk();
  const [failed, setFailed] = useState(false);
  const [going, setGoing] = useState(false);

  const start = async () => {
    if (!isLoaded) return;
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
    <main className="flex flex-1 items-center justify-center px-6 pb-24">
      <div className="w-full max-w-[20rem]">
        <h1 className="text-[length:var(--text-title)] font-semibold tracking-[-0.02em]">
          Nootles
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          An AI-native planning surface — notes, canvas, and an ambient copilot.
        </p>

        <button
          onClick={start}
          disabled={!isLoaded || going}
          className="nt-row mt-8 h-9 w-full justify-center gap-2 border bg-sunken font-medium disabled:opacity-60"
          style={{ borderColor: "var(--border)" }}
        >
          <GoogleMark width={16} height={16} />
          Continue with Google
        </button>

        <p
          role={failed ? "alert" : undefined}
          className="mt-3 text-[length:var(--text-meta-lg)] text-muted"
        >
          {failed
            ? "That didn't go through. Try again."
            : "New here? Signing in creates your account."}
        </p>
      </div>
    </main>
  );
}
