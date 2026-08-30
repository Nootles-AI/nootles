"use client";

import { useEffect, useState } from "react";
import { beginImpersonation, expiryOf } from "@/app/lib/impersonation";

/**
 * Where an operator's stand-in session lands.
 *
 * The token arrives in the URL fragment — never sent to a server, never written
 * to a referrer, so the only place it is ever spoken is this tab. The page takes
 * it, puts it where the Convex provider reads it, and replaces the entry so it
 * is not sitting in back-history.
 *
 * The route stays behind Clerk deliberately: standing in for someone takes two
 * credentials, an ops session to mint the token and your own account to spend
 * it.
 */
export default function Impersonate() {
  const [error, setError] = useState<string | null>(null);

  // The fragment is readable only on the client, so the neutral message renders
  // first (SSR and the first client render agree — no hydration mismatch) and
  // the verdict arrives on mount. Same sanctioned shape as Workspace's layout
  // restore: a one-time read of something React cannot see.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const token = location.hash.slice(1);
    if (!token || expiryOf(token) <= Date.now()) {
      setError("That link is expired or malformed. Mint a new one from ops.");
      return;
    }
    beginImpersonation(token);
    location.replace("/");
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <p className="text-sm text-[var(--muted)]">{error ?? "Starting session…"}</p>
    </main>
  );
}
