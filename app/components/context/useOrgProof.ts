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
 * Showing a workspace's GitHub organisation rule that you belong to `org`,
 * the one way anyone does it: your own GitHub connection asks GitHub, on a
 * press (`github/orgProof.verify`). Without a connection the press connects
 * one first, in its own window, and the button turns into Verify when it lands.
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
      verified = (await verify({ workspaceId })).verified;
      answer = verified
        ? { text: `Verified: GitHub lists @${account.login} in ${org}.`, problem: false }
        : {
            text: `GitHub doesn’t list @${account.login} as a member of ${org}. If you are one, check this is the GitHub account you’re in it with, and that you’ve accepted its invitation.`,
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
            label: busy ? "Verifying…" : "Verify GitHub membership",
            run: () => void run(),
            busy,
          }
        : {
            label: account ? "Reconnect GitHub to verify" : "Connect GitHub to verify",
            run: () => openConnectWindow("/api/github/connect"),
            busy: false,
          };

  return {
    action,
    blocker: personal && !personal.ready ? personal.blocker : null,
    said,
    line,
  };
}
