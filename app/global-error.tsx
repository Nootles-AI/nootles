"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import "./globals.css";
import { Interrupted } from "./components/Interrupted";

/**
 * A throw in the root layout itself — a provider — which `error.tsx` sits
 * beneath and cannot catch. This replaces the whole document, so it brings its
 * own `<html>` and styles, and a reload is the only way back worth offering:
 * there is no session left mounted to retry into.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { feature: "global-error" },
      ...(error.digest ? { extra: { digest: error.digest } } : {}),
    });
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <title>Nootles</title>
        <Interrupted title="Something went wrong">
          Nootles stopped working. Anything already saved is safe — reload to pick up where you
          left off.
        </Interrupted>
      </body>
    </html>
  );
}
