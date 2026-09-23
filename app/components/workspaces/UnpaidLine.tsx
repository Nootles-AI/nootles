"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { atLeast } from "@/convex/auth";
import { settingsPath } from "@/app/lib/containerPaths";
import { useStandIn } from "../StandIn";
import type { WorkspaceContainer } from "./ContainerContext";
import "./workspaces.css";

/**
 * One quiet line under an unpaid workspace's title, for whoever could start
 * its plan — or settle the one Stripe still holds open: where it stands, and
 * the way to billing. Nobody else is asked —
 * a member can do nothing with it — and a deployment Team cannot be bought
 * on says nothing at all.
 */
export function UnpaidLine({
  workspace,
  className = "",
}: {
  workspace: WorkspaceContainer;
  className?: string;
}) {
  const standIn = useStandIn();
  const asks = !standIn && atLeast(workspace.role, "admin");
  const ask = useQuery(
    api.teamBilling.unpaid,
    asks ? { workspaceId: workspace.workspaceId } : "skip",
  );
  if (!ask) return null;

  return (
    <p className={`nt-ws-unpaid ${className}`}>
      {workspace.name} is on the free allowance.{" "}
      <Link href={settingsPath(workspace.slug, "billing")} className="nt-ws-unpaid-go">
        {ask === "settle" ? "Settle its billing" : "Start the Team plan"}
      </Link>
    </p>
  );
}
