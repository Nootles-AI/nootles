import * as Sentry from "@sentry/nextjs";
import { installConsoleTap } from "@/app/lib/debugRing";

/**
 * Client telemetry boot — runs once, before hydration.
 *
 * Errors only. Product analytics boots from `TelemetryProvider` instead, once
 * the first paint is out of the way: PostHog's config fetch and the recorder
 * script it pulls behind it have no business on the critical path, whereas an
 * error reporter that misses the errors thrown before it loads is not one.
 *
 * Both vendors are headless: SDKs only, no widgets. All in-app UI (the
 * feedback panel, surveys) is ours. Either init is skipped cleanly when its
 * env var is absent, so local dev without keys stays silent.
 */

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
