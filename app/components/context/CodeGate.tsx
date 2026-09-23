"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useContainer } from "../workspaces/ContainerContext";
import { useOrgProof } from "./useOrgProof";

/**
 * Why a workspace's code is missing from this project's context, for a member
 * the workspace's GitHub organisation rule is holding back — and the press
 * that lets them in. Nothing for anyone the rule is not stopping: a guest's
 * code is a manager's grant, not this.
 */
export function CodeGate({ frame }: { frame?: string }) {
  const here = useContainer();
  const workspaceId = here.kind === "workspace" && here.role !== "guest" ? here.workspaceId : null;
  const status = useQuery(api.github.app.status, workspaceId ? { workspaceId } : "skip");
  if (!workspaceId || !status?.requireGithubOrg || status.orgProof.passes) return null;
  const gate = <Gate workspaceId={workspaceId} org={status.requireGithubOrg} lapsed={!!status.orgProof.verifiedAt} />;
  // Where no context panel surrounds it, it brings that panel's edge along.
  return frame ? <div className={frame}>{gate}</div> : gate;
}

function Gate({
  workspaceId,
  org,
  lapsed,
}: {
  workspaceId: Id<"workspaces">;
  org: string;
  /** Verified once, more than the rule's two weeks ago. */
  lapsed: boolean;
}) {
  const proof = useOrgProof(workspaceId, org);
  return (
    <div className="nt-codegate">
      <p>
        {lapsed
          ? `Code is hidden: your ${org} membership needs verifying again.`
          : `Code is hidden until GitHub shows you’re in ${org}.`}
      </p>
      {proof.action && (
        <button
          type="button"
          onClick={proof.action.run}
          disabled={proof.action.busy}
          className="nt-row nt-codegate-go"
        >
          {proof.action.label}
        </button>
      )}
      {proof.blocker && <p>{proof.blocker}</p>}
      {proof.said && (
        <p role={proof.said.problem ? "alert" : "status"} className={proof.said.problem ? "is-problem" : undefined}>
          {proof.said.text}
        </p>
      )}
    </div>
  );
}
