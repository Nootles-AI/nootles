"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

const SAID: Record<string, string> = {
  connected: "Connected. This window closes on its own.",
  cancelled: "Nothing was connected. You can close this window.",
  error: "That could not be connected. Close this window and try again.",
};

export function Connected() {
  const params = useSearchParams();
  const outcome = params.get("github") ?? params.get("notion") ?? "error";

  // Only a window something opened can close itself; a callback reached any
  // other way stays up and says where to go instead.
  useEffect(() => {
    if (outcome === "connected" && window.opener) {
      const timer = setTimeout(() => window.close(), 600);
      return () => clearTimeout(timer);
    }
  }, [outcome]);

  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <p className="max-w-sm text-center text-[14px] leading-relaxed text-muted">
        {SAID[outcome] ?? SAID.error}
      </p>
    </main>
  );
}
