"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useContainer } from "../workspaces/ContainerContext";
import { GitHubMark } from "./marks";
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
  const fold = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (holding !== "verified") return;
    const el = fold.current;
    // Shutting goes inert, which would drop focus waiting in the gate to the
    // page: past its time, the fold waits for focus to leave it first.
    let due = false;
    const timer = setTimeout(() => {
      due = true;
      if (!el?.contains(document.activeElement)) setHolding(null);
    }, VERIFIED_MS);
    const left = (e: FocusEvent) => {
      if (!due || !document.hasFocus()) return;
      if (!el?.contains(e.relatedTarget as Node | null)) setHolding(null);
    };
    el?.addEventListener("focusout", left);
    return () => {
      clearTimeout(timer);
      el?.removeEventListener("focusout", left);
    };
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
    <div ref={fold} className="nt-codegate-fold is-arriving" data-open={open} inert={!open}>
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
  const box = useRef<HTMLDivElement>(null);
  const press = useRef<HTMLButtonElement>(null);
  const proof = useOrgProof(workspaceId, org, {
    onStart,
    onSettled: (verified) => {
      // The press folds away once it has let them in; focus waits on the gate.
      if (verified && document.activeElement === press.current) box.current?.focus();
      onSettled(verified);
    },
  });
  // Let in, the line that says so is all there is left to say: the sentence
  // and the press fold shut as it folds open, one change of height.
  const through = proof.said !== null && !proof.said.problem;
  return (
    <div ref={box} tabIndex={-1} className="nt-codegate">
      <div className="nt-codegate-fold" data-open={!through} inert={through}>
        <div className="nt-codegate-fold-body">
          <div className="nt-codegate-part">
            <p>
              {lapsed ? (
                <>
                  Code is hidden: your <Login>{org}</Login> membership needs verifying again.
                </>
              ) : (
                <>
                  Code is hidden until GitHub shows you’re in <Login>{org}</Login>.
                </>
              )}
            </p>
            {proof.action && (
              <button
                ref={press}
                type="button"
                onClick={proof.action.run}
                // Not `disabled`: a disabled button drops the focus that pressed it.
                aria-disabled={proof.action.busy}
                className="nt-row nt-codegate-go gap-1.5"
              >
                <GitHubMark width={14} height={14} aria-hidden="true" />
                {proof.action.label}
              </button>
            )}
          </div>
        </div>
      </div>
      {proof.blocker && (
        <div className="nt-codegate-fold is-arriving">
          <div className="nt-codegate-fold-body">
            <p className="nt-codegate-part">{proof.blocker}</p>
          </div>
        </div>
      )}
      {/* Shut while another press is on its way, holding the last answer; a
          new one is a new line, so it is announced even when it repeats. */}
      {proof.line && (
        <div className="nt-codegate-fold is-arriving" data-open={!!proof.said} inert={!proof.said}>
          <div className="nt-codegate-fold-body">
            <p
              key={proof.line.n}
              role={proof.line.problem ? "alert" : "status"}
              className={`nt-codegate-part${proof.line.problem ? " is-problem" : ""}`}
            >
              {proof.line.text}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** A GitHub login, which a line may not break at its hyphen. */
function Login({ children }: { children: string }) {
  return <span className="whitespace-nowrap">{children}</span>;
}
