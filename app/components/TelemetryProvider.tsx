"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import * as Sentry from "@sentry/nextjs";
import { api } from "@/convex/_generated/api";
import { bootAnalytics, withAnalytics } from "@/app/lib/telemetry";

/**
 * How many sessions are recorded.
 *
 * rrweb serialises every DOM mutation for as long as it runs, and the two
 * surfaces this product is judged on — typing in ProseMirror and dragging on
 * the canvas — are mutation storms. Recording every session spends that on
 * every user to watch a fraction of them; a sample costs the same evidence and
 * leaves the other four sessions in five alone. Whole sessions, never parts of
 * one: half a replay answers nothing.
 */
const REPLAY_SAMPLE = 0.2;

/** Out of the way of the first paint; what is tracked before it waits in `telemetry`. */
const BOOT_DELAY_MS = 1500;

/**
 * Ties the telemetry identity to the signed-in account, so events, replays
 * and errors all answer to the same person. Renders nothing of its own, and
 * boots PostHog after the first paint — see `instrumentation-client`.
 */
export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  const profile = useQuery(api.profiles.get, user ? {} : "skip");

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    const boot = () =>
      void bootAnalytics((posthog) => {
        const record = Math.random() < REPLAY_SAMPLE;
        posthog.init(key, {
          // First-party path, rewritten to PostHog by next.config — ad-blockers
          // block the vendor domain, not ours. ui_host keeps dashboard links
          // (like the replay URL on feedback tickets) pointing at the real app.
          api_host: "/ingest",
          ui_host: "https://us.posthog.com",
          defaults: "2025-05-24",
          capture_exceptions: false, // Sentry owns errors
          disable_session_recording: !record,
          // Beta decision (disclosed at signup): replays are unmasked.
          session_recording: { maskAllInputs: false },
        });
        if (record) posthog.startSessionRecording();
      });
    const idle = typeof window.requestIdleCallback === "function";
    const id = idle
      ? window.requestIdleCallback(boot, { timeout: BOOT_DELAY_MS })
      : window.setTimeout(boot, BOOT_DELAY_MS);
    return () => {
      if (idle) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    const email = user.primaryEmailAddress?.emailAddress;
    const traits = {
      ...(email ? { email } : {}),
      ...(user.fullName ? { name: user.fullName } : {}),
      ...(profile?.role ? { role: profile.role } : {}),
      ...(profile?.useCase ? { useCase: profile.useCase } : {}),
    };
    withAnalytics((posthog) => posthog.identify(user.id, traits));
    Sentry.setUser({ id: user.id, ...(email ? { email } : {}) });
  }, [user, profile]);

  return <>{children}</>;
}
