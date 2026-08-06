"use client";

import { useEffect, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { api } from "@/convex/_generated/api";

/**
 * Ties the telemetry identity to the signed-in account, so events, replays
 * and errors all answer to the same person. Renders nothing of its own.
 */
export function TelemetryProvider({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  const profile = useQuery(api.profiles.get, user ? {} : "skip");
  const stampEmail = useMutation(api.profiles.stampEmail);
  const stamped = useRef(false);

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
      if (posthog.__loaded) {
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
  }, [user, profile]);

  return <>{children}</>;
}
