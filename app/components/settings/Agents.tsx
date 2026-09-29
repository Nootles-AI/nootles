"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DialogBox } from "@/app/components/Dialog";
import { editSummary } from "@/app/lib/mcp/format";
import { Check, Copy, Sparkle } from "@/app/components/Icons";
import "../mcp/mcp.css";

const WHEN = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * MCP connections: the server URL to give an agent, every agent holding
 * access (each one disconnectable), and what they have lately changed (each
 * change undoable). Drawn only for an account MCP is open to — an internal
 * owner — so nobody else's Settings changes.
 */
export function AgentsSection() {
  const status = useQuery(api.mcp.oauth.myConnections, {});
  if (!status?.eligible) return null;
  return (
    <section className="nt-set-section" aria-labelledby="nt-set-agents">
      <h2 id="nt-set-agents" className="nt-set-label">
        Agents
      </h2>
      <ul className="nt-set-list">
        <li>
          <div className="nt-set-row">
            <span className="nt-set-glyph">
              <Sparkle />
            </span>
            <div className="nt-set-body-col">
              <div className="nt-set-name">MCP server</div>
              <p className="nt-set-note">
                Add this URL as a custom connector in Claude, or to any MCP client. It reaches only your own
                pages that are served on NML: it can read them and, if you allow it when connecting, edit them.
                Every edit shows on the page and can be undone.
              </p>
              {status.serverUrl && <ServerUrl url={status.serverUrl} />}
              {!status.enabled && <p className="nt-set-problem">MCP is turned off on this deployment right now.</p>}
            </div>
          </div>
        </li>
        {status.connections.map((connection) => (
          <li key={connection.grantId}>
            <ConnectionRow {...connection} />
          </li>
        ))}
      </ul>
      <AgentEdits />
    </section>
  );
}

const AGO = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 minutes ago", from a timestamp the render already has. */
function ago(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds > -45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return AGO.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return AGO.format(hours, "hour");
  return WHEN.format(at);
}

const UNDO_FAILURES: Record<string, string> = {
  "changed-since": "The page has changed there since, so undoing would take that work too.",
  inexact: "This edit can no longer be undone exactly.",
  expired: "Too old to undo.",
  "already-undone": "Already undone.",
};

function AgentEdits() {
  const edits = useQuery(api.mcp.docs.recentEdits, {});
  const undo = useAction(api.mcp.edit.undoMine);
  const [busy, setBusy] = useState<Id<"mcpEdits"> | null>(null);
  const [failure, setFailure] = useState<{ editId: Id<"mcpEdits">; text: string } | null>(null);
  // One clock per render of the list, read where it is needed rather than kept.
  const [now] = useState(() => Date.now());
  if (!edits?.length) return null;

  const run = async (editId: Id<"mcpEdits">) => {
    setBusy(editId);
    setFailure(null);
    try {
      const result = await undo({ editId });
      if (result.status === "refused") setFailure({ editId, text: UNDO_FAILURES[result.reason] ?? "It could not be undone." });
    } catch {
      setFailure({ editId, text: "It could not be undone. Try again in a moment." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <h3 className="nt-set-label nt-mcp-sublabel">Recent agent edits</h3>
      <ul className="nt-set-list">
        {edits.map((edit) => (
          <li key={edit.editId}>
            <div className="nt-set-row">
              <span className="nt-set-glyph" aria-hidden />
              <div className="nt-set-body-col">
                <div className="nt-set-name">
                  <Link href={`/p/${edit.projectId}?page=${edit.pageId}`} className="hover:underline">
                    {edit.pageTitle || "Untitled"}
                  </Link>
                </div>
                <div className="nt-set-meta">
                  {edit.clientName} · {editSummary(edit.counts)} · {ago(edit.createdAt, now)}
                  {edit.undoneAt ? " · undone" : ""}
                </div>
                {failure?.editId === edit.editId && (
                  <p role="alert" className="nt-set-problem">
                    {failure.text}
                  </p>
                )}
              </div>
              {edit.undoable && !edit.undoneAt && (
                <div className="nt-set-actions">
                  <button type="button" onClick={() => run(edit.editId)} disabled={busy !== null} className="nt-row px-2.5">
                    {busy === edit.editId ? "Undoing…" : "Undo"}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function ServerUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Selecting the text by hand still works; nothing to report.
    }
  };
  return (
    <div className="nt-mcp-url">
      <code>{url}</code>
      <button type="button" onClick={copy} className="nt-icon-btn is-sm" aria-label={copied ? "Copied" : "Copy URL"}>
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

function ConnectionRow({
  grantId,
  clientName,
  canEdit,
  createdAt,
  lastUsedAt,
}: {
  grantId: Id<"mcpGrants">;
  clientName: string;
  canEdit: boolean;
  createdAt: number;
  lastUsedAt?: number;
}) {
  const disconnect = useMutation(api.mcp.oauth.disconnect);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const cancel = useCallback(() => setConfirming(false), []);

  const confirm = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await disconnect({ grantId });
      setConfirming(false);
    } catch {
      setFailure("It could not be disconnected. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nt-set-row">
      <span className="nt-set-glyph" aria-hidden />
      <div className="nt-set-body-col">
        <div className="nt-set-name">{clientName}</div>
        <div className="nt-set-meta">
          {canEdit ? "Can read and edit" : "Read only"} · Connected {WHEN.format(createdAt)}
          {lastUsedAt ? ` · last used ${WHEN.format(lastUsedAt)}` : " · not used yet"}
        </div>
      </div>
      <div className="nt-set-actions">
        <button type="button" onClick={() => setConfirming(true)} className="nt-row px-2.5">
          Disconnect
        </button>
      </div>
      {confirming && (
        <DialogBox label={`Disconnect ${clientName}`} onClose={cancel}>
          <p className="text-sm font-medium">Disconnect {clientName}?</p>
          <p className="mt-1.5 text-[13px] text-muted">
            It loses access at once. Connecting it again means signing in from the agent.
          </p>
          {failure && (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {failure}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-1">
            <button type="button" onClick={cancel} autoFocus className="nt-row px-2.5">
              Cancel
            </button>
            <button type="button" onClick={confirm} disabled={busy} className="nt-row px-2.5 font-medium">
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </DialogBox>
      )}
    </div>
  );
}
