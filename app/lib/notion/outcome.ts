"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { FailureReason } from "@/app/api/notion/oauth";

/**
 * How the Notion OAuth round trip ended, read off the URL it landed on.
 *
 * `/api/notion/callback` reports back as `?notion=connected|cancelled|error`
 * with `&reason=` on the last, and until this hook nothing read it: a cancel
 * or a failure put you back exactly where you started with no sentence about
 * it, which reads as the button doing nothing.
 */
export type NotionOutcome = "connected" | "cancelled" | "error";

const OUTCOMES: ReadonlySet<string> = new Set<NotionOutcome>([
  "connected",
  "cancelled",
  "error",
]);

/**
 * The outcome the page arrived with, held until dismissed.
 *
 * Read once, at mount, and the query string is stripped straight away rather
 * than on dismiss: the sentence describes one round trip, and a URL that keeps
 * saying "connected" would replay it on every reload, in a bookmark, and to
 * whoever the link is pasted to. Held in state instead, so the line stays on
 * screen with a clean address bar and leaves when the reader says so.
 *
 * A one-time read rather than a value derived from the params during render,
 * because the params are about to be erased — deriving would erase the
 * sentence with them.
 */
export function useNotionOutcome(): {
  outcome: NotionOutcome | null;
  reason: string | null;
  dismiss: () => void;
} {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const [held, setHeld] = useState<{
    outcome: NotionOutcome;
    reason: string | null;
  } | null>(() => {
    const outcome = params.get("notion");
    if (!outcome || !OUTCOMES.has(outcome)) return null;
    return { outcome: outcome as NotionOutcome, reason: params.get("reason") };
  });

  const carried = params.has("notion") || params.has("reason");
  useEffect(() => {
    if (!carried) return;
    const rest = new URLSearchParams(params);
    rest.delete("notion");
    rest.delete("reason");
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [carried, params, pathname, router]);

  const dismiss = useCallback(() => setHeld(null), []);

  return { outcome: held?.outcome ?? null, reason: held?.reason ?? null, dismiss };
}

const FAILED: Record<FailureReason, string> = {
  state:
    "the sign-in did not start from this browser, so it was not trusted. Start it again from here.",
  no_code: "Notion sent the browser back without an authorization code. Try again.",
  exchange:
    "Notion would not exchange the code for a token. Try again, and check the integration's settings if it keeps happening.",
  unconfigured:
    "this deployment has no Notion integration configured. Set NOTION_CLIENT_ID, NOTION_CLIENT_SECRET and NOTION_REDIRECT_URI.",
};

/**
 * The one sentence a surface says about how the round trip ended, and whether
 * it is a problem. Decided here so every surface draws the same outcome the
 * same way: a cancelled trip is a fact, not a failure, and a line that says
 * "cancelled" in danger ink reads as a warning about nothing.
 */
export type OutcomeLine = { text: string; problem: boolean };

export function describeOutcome(outcome: NotionOutcome, reason: string | null): OutcomeLine {
  switch (outcome) {
    case "connected":
      return { text: "Notion connected.", problem: false };
    case "cancelled":
      return { text: "Connection cancelled.", problem: false };
    case "error": {
      const why = reason && reason in FAILED ? FAILED[reason as FailureReason] : null;
      return {
        text: why
          ? `Notion could not be connected: ${why}`
          : "Notion could not be connected. Try again.",
        problem: true,
      };
    }
  }
}
