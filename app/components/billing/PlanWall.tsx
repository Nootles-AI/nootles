"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import type { Meter } from "@/convex/entitlements";
import { rememberIntent, type BillingIntent } from "@/app/lib/billing/intent";
import { PaywallSheet } from "./PaywallSheet";

/**
 * The wall, raised where the person was standing.
 *
 * It is not a dialog that links to a pricing page. It is the paywall surface
 * itself, opened at the sentence that stopped them and able to grow in place
 * into the plans — so being stopped, reading the price, and paying are one
 * continuous surface rather than three destinations.
 *
 * Raising it also notes what was being done. The note authorises nothing on its
 * own (see `intent.ts`); it is what lets the way back be named out loud, and
 * what makes the return land on the action rather than on the home screen.
 */
export function PlanWall({
  meter,
  intent,
  onClose,
  onResume,
}: {
  meter: Meter;
  /** What to do again once this is paid for. */
  intent: BillingIntent;
  onClose: () => void;
  /**
   * Granted without leaving — a code redeemed in place. The sheet has already
   * played its deployment; close and do the thing.
   */
  onResume: () => void;
}) {
  const pathname = usePathname();

  // Held in a ref rather than depended on: callers build the intent inline, so
  // it is a fresh object every render and would otherwise rewrite the note on
  // every keystroke happening underneath the wall.
  const latest = useRef(intent);
  useEffect(() => {
    latest.current = intent;
  });

  useEffect(() => {
    rememberIntent(latest.current, pathname);
  }, [pathname]);

  return (
    <PaywallSheet
      mode="overlay"
      meter={meter}
      onDismiss={onClose}
      onResume={onResume}
    />
  );
}
