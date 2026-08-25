"use client";

import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { api } from "@/convex/_generated/api";

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

/** Long enough to be out of the way, short enough not to lose early events. */
const BOOT_DELAY_MS = 1500;

/**
 * Ties the telemetry identity to the signed-in account, so events, replays
 * and errors all answer to the same person. Renders nothing of its own, and
 * boots PostHog after the first paint — see `instrumentation-client`.
 */
export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  const profile = useQuery(api.profiles.get, user ? {} : "skip");
  const stampEmail = useMutation(api.profiles.stampEmail);
  const stamped = useRef(false);
  const [analytics, setAnalytics] = useState(false);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key || posthog.__loaded) return;
    const boot = () => {
      try {
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
        setAnalytics(true);
      } catch {
        // Telemetry never breaks the app.
      }
    };
    const idle = typeof window.requestIdleCallback === "function";
    const id = idle
      ? window.requestIdleCallback(boot, { timeout: BOOT_DELAY_MS })
      : window.setTimeout(boot, BOOT_DELAY_MS);
    return () => {
      if (idle) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, []);

  // Once the profile row exists, keep its email current — the ops dashboard
  // reads it. Once per session; the mutation no-ops when nothing changed.
  useEffect(() => {
    if (stamped.current || !user || !profile) return;
    stamped.current = true;
    void stampEmail({}).catch(() => {});
  }, [user, profile, stampEmail]);

  useEffect(() => {
    if (!user) return;
    const email = user.primaryEmailAddress?.emailAddress;
    try {
      if (analytics) {
        posthog.identify(user.id, {
          ...(email ? { email } : {}),
          ...(user.fullName ? { name: user.fullName } : {}),
          ...(profile?.role ? { role: profile.role } : {}),
          ...(profile?.useCase ? { useCase: profile.useCase } : {}),
        });
      }
    } catch {
      // Telemetry never breaks the app.
    }
    Sentry.setUser({ id: user.id, ...(email ? { email } : {}) });
  }, [user, profile, analytics]);

  return <>{children}</>;
}
