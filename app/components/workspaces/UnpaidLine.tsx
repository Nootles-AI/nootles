"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { atLeast } from "@/convex/auth";
import { settingsPath } from "@/app/lib/containerPaths";
import { useStandIn } from "../StandIn";
import type { WorkspaceContainer } from "./ContainerContext";
import { Fold } from "./settings/parts";
import "./workspaces.css";

/**
 * One quiet line under an unpaid workspace's title, for whoever could start
 * its plan — or fix the one Stripe still holds open: where it stands, and
 * the way to billing. Nobody else is asked —
 * a member can do nothing with it — and a deployment Team cannot be bought
 * on says nothing at all.
 *
 * It answers after the projects under it are already drawn, so it folds open
 * and moves them rather than throwing them down a line — and once the plan
 * starts, it folds shut again, still saying what it said.
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
  // What it last said, held while it folds shut.
  const [said, setSaid] = useState<{ ask: string; name: string; slug: string } | null>(null);
  const { name, slug } = workspace;
  if (ask && (ask !== said?.ask || name !== said.name || slug !== said.slug)) {
    setSaid({ ask, name, slug });
  }
  if (!said) return null;

  return (
    <Fold arriving open={!!ask} className={className}>
      <p className="nt-ws-unpaid">
        {said.name} is on the free allowance.{" "}
        <Link href={settingsPath(said.slug, "billing")} className="nt-ws-aside-link">
          {said.ask === "settle" ? "Fix its billing" : "See the Team plan"}
        </Link>
      </p>
    </Fold>
  );
}
