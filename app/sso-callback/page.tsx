"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";

/**
 * Where Google returns to. The component completes the handshake and navigates
 * on — including the sign-in-to-sign-up transfer a first-time account needs, so
 * there is no separate sign-up route.
 *
 * A share link that asked for the sign-in rides along as `?return=`: the
 * transfer leg does not preserve `redirectUrlComplete` the way plain sign-in
 * does, and without this a brand-new account lands on the front door instead
 * of the document that invited it. Forced for both legs, and only ever a
 * share path — anything else in the param is someone else's URL and is not
 * followed.
 *
 * Deliberately blank: this is on screen for a few hundred milliseconds, and a
 * spinner that brief reads as a flash of something broken.
 */
export default function SSOCallbackPage() {
  return (
    <Suspense>
      <Callback />
    </Suspense>
  );
}

function Callback() {
  const wanted = useSearchParams().get("return");
  const destination =
    wanted && wanted.startsWith("/share/") ? wanted : "/";
  return (
    <AuthenticateWithRedirectCallback
      signInForceRedirectUrl={destination}
      signUpForceRedirectUrl={destination}
    />
  );
}
