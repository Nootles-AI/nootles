"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { reason } from "@/app/lib/github";
import { openConnectWindow } from "./connectWindow";

export type ProofLine = { text: string; problem: boolean };

/**
 * Showing a workspace's GitHub organisation rule that you belong to `org`,
 * the one way anyone does it: your own GitHub connection asks GitHub, on a
 * press (`github/orgProof.verify`). Without a connection the press connects
 * one first, in its own window, and the button turns into Verify when it lands.
 *
 * `action` is null while there is nothing to press: the connection is still
 * being asked after, or this deployment cannot hold one (`blocker`).
 */
export function useOrgProof(workspaceId: Id<"workspaces">, org: string) {
  const personal = useQuery(api.github.account.status);
  const verify = useAction(api.github.orgProof.verify);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<ProofLine | null>(null);

  const account = personal?.account ?? null;
  const connected = !!account && !account.invalidAt;

  const run = async () => {
    if (busy || !account) return;
    setBusy(true);
    setSaid(null);
    try {
      const answer = await verify({ workspaceId });
      setSaid(
        answer.verified
          ? { text: `Verified: GitHub lists @${account.login} in ${org}.`, problem: false }
          : {
              text: `GitHub doesn’t list @${account.login} as a member of ${org}.`,
              problem: true,
            },
      );
    } catch (error) {
      setSaid({ text: reason(error), problem: true });
    }
    setBusy(false);
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
            label: account ? "Reconnect GitHub" : "Connect GitHub",
            run: () => openConnectWindow("/api/github/connect"),
            busy: false,
          };

  return {
    action,
    blocker: personal && !personal.ready ? personal.blocker : null,
    said,
  };
}
