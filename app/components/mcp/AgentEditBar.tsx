"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { editSummary } from "@/app/lib/mcp/format";

const FAILURES: Record<string, string> = {
  "changed-since": "Changed since — can’t undo",
  inexact: "Can’t be undone exactly",
  expired: "Too old to undo",
  "already-undone": "Already undone",
  busy: "Page busy — try again",
};

/**
 * The page's answer to an agent's edit (NT-123). An MCP edit lands for real the
 * moment it is made — it is applied, not proposed — so what the page owes the
 * person is the same bar the chat review keeps at the foot of the window: who
 * changed the page, how much, and the two answers. Undo is the quiet one, as
 * Revert is there; Keep only stops asking, and the edit stays undoable from
 * Settings → Agents until its window closes.
 *
 * Shown to the page's owner only (the query decides), for the newest edit not
 * yet answered. Portaled, because it is fixed to the window and the page is zoomed.
 */
export function AgentEditBar({ docId }: { docId: string }) {
  const pending = useQuery(api.mcp.docs.pendingOnPage, { docId });
  const undo = useAction(api.mcp.edit.undoMine);
  const keep = useMutation(api.mcp.docs.keepEdit);
  const [busy, setBusy] = useState<"undo" | "keep" | null>(null);
  const [failure, setFailure] = useState<{ editId: string; text: string } | null>(null);

  if (!pending) return null;
  const failed = failure?.editId === pending.editId ? failure.text : null;

  const answer = async (which: "undo" | "keep") => {
    setBusy(which);
    setFailure(null);
    try {
      if (which === "keep") await keep({ editId: pending.editId });
      else {
        const result = await undo({ editId: pending.editId });
        if (result.status === "refused") setFailure({ editId: pending.editId, text: FAILURES[result.reason] ?? "Couldn’t undo" });
      }
    } catch {
      setFailure({ editId: pending.editId, text: "That didn’t work — try again" });
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div
      className="nt-review-bar nt-agent-bar"
      style={{ zIndex: "var(--z-sticky)" }}
      role="status"
      aria-busy={busy !== null}
      aria-label={`${pending.clientName} edited this page`}
    >
      <span className="nt-agent-bar-who">{pending.clientName} edited this page</span>
      <span className="nt-review-sep" aria-hidden />
      {/* A refusal takes the counts' place: it is the answer to the button just pressed. */}
      {failed ? (
        <span className="nt-review-failure nt-agent-bar-failure" role="alert">
          {failed}
        </span>
      ) : (
        <span className="nt-review-count">{editSummary(pending.counts)}</span>
      )}
      <span className="nt-review-sep" aria-hidden />
      <button
        className="nt-review-action is-quiet"
        disabled={busy !== null}
        onClick={() => answer("undo")}
        title="Put back exactly what the agent changed. Refused if you have edited there since."
      >
        {busy === "undo" ? "Undoing…" : "Undo"}
      </button>
      <button className="nt-review-action is-keep" disabled={busy !== null} onClick={() => answer("keep")}>
        {busy === "keep" ? "Keeping…" : "Keep"}
      </button>
    </div>,
    document.body,
  );
}
