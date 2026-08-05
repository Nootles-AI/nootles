import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { installConsoleTap } from "@/app/lib/debugRing";

/**
 * Client telemetry boot — runs once, before hydration.
 *
 * Both vendors are headless here: SDKs only, no widgets. All in-app UI (the
 * feedback panel, surveys) is ours. Either init is skipped cleanly when its
 * env var is absent, so local dev without keys stays silent.
 */

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
if (posthogKey) {
  try {
    posthog.init(posthogKey, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      defaults: "2025-05-24",
      capture_exceptions: false, // Sentry owns errors
      // Beta decision (disclosed at signup): unmasked replays, 100% sampling.
      session_recording: { maskAllInputs: false },
    });
    posthog.startSessionRecording();
  } catch {
    // Telemetry never breaks the app.
  }
}

const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sampleRate: 1.0,
    release: process.env.NEXT_PUBLIC_COMMIT_SHA,
  });
}

installConsoleTap();

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
