"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Meter } from "@/convex/entitlements";
import { rememberIntent, type BillingIntent } from "@/app/lib/billing/intent";
import { dismissalOf, PaywallSheet } from "./PaywallSheet";
import { TeamWall } from "./TeamWall";

type WallProps = {
  meter: Meter;
  /** What to do again once this is paid for. */
  intent: BillingIntent;
  onClose: () => void;
  /**
   * Granted without leaving — a code redeemed in place. The sheet has already
   * played its deployment; close and do the thing.
   */
  onResume: () => void;
};

/**
 * The wall, raised where the person was standing.
 *
 * It is not a dialog that links to a pricing page. It is the paywall surface
 * itself, opened at the sentence that stopped them and able to grow in place
 * into the plans — so being stopped, reading the price, and paying are one
 * continuous surface rather than three destinations.
 *
 * Whose allowance ran out is asked of where it happened — the project, or
 * the workspace a project was being made in — by the same query the walls
 * are drawn from (`entitlements.forContainer`). A workspace's is the
 * workspace's wall: nobody can buy their way past it alone.
 */
export function PlanWall({
  projectId,
  workspaceId,
  ...wall
}: WallProps & {
  projectId?: Id<"projects"> | null;
  workspaceId?: Id<"workspaces"> | null;
}) {
  const standing = useQuery(
    api.entitlements.forContainer,
    projectId ? { projectId } : workspaceId ? { workspaceId } : {},
  );
  if (standing === undefined) return null;
  const container = standing?.container;
  if (container?.kind === "workspace") {
    return (
      <TeamWall
        meter={wall.meter}
        workspaceId={container.workspaceId}
        name={container.name}
        // Raised at a New project, it closes onto the home it was raised on.
        back={wall.intent.kind === "newProject" ? "Not now" : dismissalOf(wall.intent)}
        onClose={wall.onClose}
      />
    );
  }
  return <AccountWall {...wall} />;
}

/**
 * Raising it also notes what was being done. The note authorises nothing on
 * its own (see `intent.ts`); it is what lets the way back be named out loud,
 * and what makes the return land on the action rather than on the home
 * screen.
 */
function AccountWall({ meter, intent, onClose, onResume }: WallProps) {
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
