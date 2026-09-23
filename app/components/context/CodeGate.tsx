"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useContainer } from "../workspaces/ContainerContext";
import { useOrgProof } from "./useOrgProof";

/** How long "Verified" stays up once the gate has nothing left to hold back. */
const VERIFIED_MS = 2000;

type Drawn = { org: string; lapsed: boolean };

/**
 * Why a workspace's code is missing from this project's context, for a member
 * the workspace's GitHub organisation rule is holding back — and the press
 * that lets them in. Nothing for anyone the rule is not stopping: a guest's
 * code is a manager's grant, not this.
 *
 * It folds open and shut rather than appearing in a frame, and a proof that
 * lets them in keeps it up long enough to read that it worked.
 */
export function CodeGate({ frame }: { frame?: boolean }) {
  const here = useContainer();
  const workspaceId = here.kind === "workspace" && here.role !== "guest" ? here.workspaceId : null;
  return workspaceId ? <Fold workspaceId={workspaceId} frame={!!frame} /> : null;
}

function Fold({ workspaceId, frame }: { workspaceId: Id<"workspaces">; frame: boolean }) {
  const status = useQuery(api.github.app.status, { workspaceId });
  const org = status?.requireGithubOrg ?? null;
  const held = !!status && !!org && !status.orgProof.passes;
  const lapsed = !!status?.orgProof.verifiedAt;

  // Shut, the fold goes on drawing what it last held, so it is there as it closes.
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  if (held && org && (drawn?.org !== org || drawn.lapsed !== lapsed)) setDrawn({ org, lapsed });

  const [holding, setHolding] = useState<"pressing" | "verified" | null>(null);
  useEffect(() => {
    if (holding !== "verified") return;
    const timer = setTimeout(() => setHolding(null), VERIFIED_MS);
    return () => clearTimeout(timer);
  }, [holding]);

  if (!drawn) return null;
  const open = held || holding !== null;
  const gate = (
    <Gate
      workspaceId={workspaceId}
      {...drawn}
      onStart={() => setHolding("pressing")}
      onSettled={(verified) => setHolding(verified ? "verified" : null)}
    />
  );
  return (
    <div className="nt-codegate-fold is-arriving" data-open={open} inert={!open}>
      <div className="nt-codegate-fold-body">
        {/* Where no context panel surrounds it, it brings that panel's edge
            and heading along, so it sits under a label like every rail block. */}
        {frame ? (
          <section className="nt-sbctx" aria-label="Context">
            <div className="nt-section-label">Context</div>
            {gate}
          </section>
        ) : (
          gate
        )}
      </div>
    </div>
  );
}

function Gate({
  workspaceId,
  org,
  lapsed,
  onStart,
  onSettled,
}: {
  workspaceId: Id<"workspaces">;
  org: string;
  /** Verified once, more than the rule's two weeks ago. */
  lapsed: boolean;
  onStart: () => void;
  onSettled: (verified: boolean) => void;
}) {
  const proof = useOrgProof(workspaceId, org, { onStart, onSettled });
  // Let in, the line that says so is all there is left to say.
  const through = proof.said !== null && !proof.said.problem;
  return (
    <div className="nt-codegate">
      {!through && (
        <p>
          {lapsed
            ? `Code is hidden: your ${org} membership needs verifying again.`
            : `Code is hidden until GitHub shows you’re in ${org}.`}
        </p>
      )}
      {proof.action && !through && (
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
