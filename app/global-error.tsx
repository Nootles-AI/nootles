"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import "./globals.css";
import { Interrupted } from "./components/Interrupted";
import { fontVariables } from "./fonts";

/**
 * A throw in the root layout itself — a provider — which `error.tsx` sits
 * beneath and cannot catch. This replaces the whole document, so it brings its
 * own `<html>`, styles and faces. "Try again" re-renders the providers, which
 * is enough when what threw was passing; a reload is there for when it is not.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { feature: "global-error" },
      ...(error.digest ? { extra: { digest: error.digest } } : {}),
    });
  }, [error]);

  return (
    <html lang="en" className={`${fontVariables} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <title>Nootles</title>
        <Interrupted title="Something went wrong" retry={unstable_retry}>
          Nootles stopped working. Anything already saved is safe — try again, or reload to pick
          up where you left off.
        </Interrupted>
      </body>
    </html>
  );
}
