"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

/**
 * Where Google returns to. The component completes the handshake and navigates
 * on — including the sign-in-to-sign-up transfer a first-time account needs, so
 * there is no separate sign-up route.
 *
 * Deliberately blank: this is on screen for a few hundred milliseconds, and a
 * spinner that brief reads as a flash of something broken.
 */
export default function SSOCallbackPage() {
  return (
    <AuthenticateWithRedirectCallback
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
    />
  );
}
