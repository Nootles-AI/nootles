"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Feature, Features } from "@/convex/plans";
import { useContainer } from "@/app/components/workspaces/ContainerContext";

/**
 * One feature of the plan in force here, by name — so no component has to
 * know what a workspace is, or which plan includes what.
 *
 * Inside a project, pass it: the project decides, as it does for `usePlan` —
 * the workspace's in a workspace project the caller writes in, their own
 * otherwise. Without one it is the container the page is in: a workspace's
 * home and settings ask about the workspace, everywhere else about the
 * account.
 *
 * Undefined until there is an answer, and while signed out. Like `usePlan`,
 * this only decides what to draw; every feature is enforced again in Convex.
 */
export function useEntitlement<F extends Feature>(
  feature: F,
  projectId?: Id<"projects"> | null,
): Features[F] | undefined {
  const container = useContainer();
  const standing = useQuery(
    api.entitlements.forContainer,
    projectId
      ? { projectId }
      : container.kind === "workspace"
        ? { workspaceId: container.workspaceId }
        : {},
  );
  return standing?.features[feature];
}
