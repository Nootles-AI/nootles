"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Interrupted } from "./components/Interrupted";

/**
 * Every route's last word on a render that threw. It sits under the root
 * layout, so the providers — Clerk, Convex, the stand-in banner — stay up and
 * "Try again" re-renders the page into a session that is still live.
 *
 * Next's own fallback reports nowhere, so the throw is sent to Sentry here: a
 * crash seen only by the person it happened to is one nobody fixes.
 */
export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { feature: "route-error" },
      ...(error.digest ? { extra: { digest: error.digest } } : {}),
    });
  }, [error]);

  return (
    <Interrupted title="Something went wrong" retry={unstable_retry}>
      This screen stopped working. Anything already saved is safe — try again, or reload
      if it keeps happening.
    </Interrupted>
  );
}
