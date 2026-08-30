"use client";

import Link from "next/link";
import { Wordmark } from "@/app/components/Brand";
import { useWaitingIntent } from "@/app/lib/billing/useWaitingIntent";
import { PaywallSheet } from "./PaywallSheet";
import "./paywall.css";

/**
 * The plan screen — the same sheet the wall raises, standing on its own.
 *
 * It is one surface used twice rather than two surfaces kept in step: someone
 * who hit a wall, paid, and came back from Stripe lands on the object they
 * left, in the same shape and the same language. It is also where a subscriber
 * returns to cancel, which is why it stays a real page with a real URL — a
 * thing you can only reach by first being refused is a thing that reads as a
 * trap.
 *
 * `?checkout=done` opens it on the moment of arrival; the query string is only
 * the cue, and whether anyone is actually on Pro is read from the entitlement,
 * because a query string is something anyone can type.
 */
export function Upgrade({ outcome }: { outcome: string | null }) {
  const waiting = useWaitingIntent();

  return (
    <div className="nt-pw-page">
      <header className="nt-pw-topbar">
        <Link href="/" aria-label="Nootles">
          <Wordmark height={18} />
        </Link>
        <Link href={waiting?.from ?? "/"} className="nt-note hover:underline">
          {waiting ? "Back to what you were doing" : "Back to your projects"}
        </Link>
      </header>
      <div className="nt-pw-page-body">
        <PaywallSheet mode="page" outcome={outcome} />
      </div>
    </div>
  );
}
