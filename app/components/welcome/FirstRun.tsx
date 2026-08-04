"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Sends a brand new account to the welcome screen, and nobody else.
 *
 * "New" is deliberately two conditions rather than one. A missing profile row
 * on its own would also describe every account that existed before first run
 * did — and dropping those people into a survey, projects and all, would be
 * the worst possible greeting. An empty project list is what distinguishes
 * them, and it stops being true the moment either flow finishes.
 *
 * Renders nothing while the answer is unknown. Both queries resolve in the
 * same round trip the projects screen was already making, so this is a frame,
 * and a skeleton for one frame is a flicker.
 */
export function FirstRun({ children }: { children: ReactNode }) {
  const router = useRouter();
  const profile = useQuery(api.profiles.get, {});
  const projects = useQuery(api.projects.list, {});

  const fresh = profile === null && projects?.length === 0;

  useEffect(() => {
    if (fresh) router.replace("/welcome");
  }, [fresh, router]);

  if (profile === undefined || projects === undefined || fresh) return null;
  return <>{children}</>;
}
