"use client";

import { useEffect, useRef, useState } from "react";

const BUILT = process.env.NEXT_PUBLIC_COMMIT_SHA ?? "dev";
const POLL_MS = 5 * 60 * 1000;

/**
 * Tells a long-lived tab that the app has moved on without it. The bundle
 * carries its build sha; /api/version answers with the serving one; a
 * mismatch — checked on focus and every few minutes — earns one quiet pill.
 * Dismissal is per-sha, so the same update never nags twice.
 */
export function UpdateToast() {
  const [stale, setStale] = useState(false);
  const dismissed = useRef<string | null>(null);
  const latest = useRef<string | null>(null);

  useEffect(() => {
    if (BUILT === "dev") return;
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { sha } = (await res.json()) as { sha: string };
        if (!alive || sha === "dev") return;
        if (sha !== BUILT) {
          latest.current = sha;
          if (dismissed.current !== sha) setStale(true);
        }
      } catch {
        // Offline or mid-deploy; the next check answers.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const t = setInterval(() => void check(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    void check();
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="nt-update" role="status">
      <span>Nootles has been updated.</span>
      <button className="nt-update-go" onClick={() => window.location.reload()}>
        Refresh
      </button>
      <button
        className="nt-update-x"
        aria-label="Not now"
        onClick={() => {
          dismissed.current = latest.current;
          setStale(false);
        }}
      >
        ×
      </button>
    </div>
  );
}
