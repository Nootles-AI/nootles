"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { reason } from "@/app/lib/github";
import { openConnectWindow } from "./connectWindow";

/** An answer to a press; `n` counts them, so a repeated answer is still a new one. */
export type ProofLine = { text: string; problem: boolean; n: number };

/**
 * Showing a workspace's GitHub organisation rule that you belong to `org`.
 * Your own GitHub connection says who you are; the workspace's GitHub App asks
 * the organisation (`github/orgProof`). Connecting is the one thing asked of
 * you: the check runs as the connection lands, and again every night after,
 * so the press here is only for checking now rather than waiting.
 *
 * `action` is null while there is nothing to press: the connection is still
 * being asked after, or this deployment cannot hold one (`blocker`).
 * `watch` hears a press start and settle: the rule's live answer can turn
 * before the action returns, so whatever the answer would take away holds
 * itself up across the press, and long enough after it for the line to be read.
 *
 * `said` is the answer to the last press, gone while another is on its way;
 * `line` goes on holding it after, so the line that says it can fold shut
 * rather than vanish.
 */
export function useOrgProof(
  workspaceId: Id<"workspaces">,
  org: string,
  watch?: { onStart?: () => void; onSettled?: (verified: boolean) => void },
) {
  const personal = useQuery(api.github.account.status);
  const verify = useAction(api.github.orgProof.verify);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ProofLine | null>(null);
  const [line, setLine] = useState<ProofLine | null>(null);

  const account = personal?.account ?? null;
  const connected = !!account && !account.invalidAt;

  const run = async () => {
    if (busy || !account) return;
    setBusy(true);
    setSaid(null);
    watch?.onStart?.();
    let verified = false;
    let answer: Omit<ProofLine, "n">;
    try {
      const proof = await verify({ workspaceId });
      const who = `@${proof.login ?? account.login}`;
      verified = proof.verified;
      answer = verified
        ? { text: `Verified: GitHub lists ${who} in ${org}.`, problem: false }
        : {
            text: `GitHub doesn’t list ${who} as a member of ${org}. If you are one, check this is the GitHub account you’re in it with, and that you’ve accepted its invitation.`,
            problem: true,
          };
    } catch (error) {
      answer = { text: reason(error), problem: true };
    }
    const next = { ...answer, n: (line?.n ?? 0) + 1 };
    setSaid(next);
    setLine(next);
    setBusy(false);
    watch?.onSettled?.(verified);
  };

  const action: { label: string; run: () => void; busy: boolean } | null =
    !personal || !personal.ready
      ? null
      : connected
        ? {
            label: busy ? "Checking…" : "Check now",
            run: () => void run(),
            busy,
          }
        : {
            label: account ? "Reconnect GitHub" : "Connect GitHub",
            run: () => openConnectWindow("/api/github/connect"),
            busy: false,
          };

  return {
    action,
    /** A working connection, which is all the nightly check needs from them. */
    connected,
    blocker: personal && !personal.ready ? personal.blocker : null,
    said,
    line,
  };
}
