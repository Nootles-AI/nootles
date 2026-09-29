"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DialogBox } from "@/app/components/Dialog";
import { Check, Copy, Sparkle } from "@/app/components/Icons";
import "../mcp/mcp.css";

const WHEN = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * MCP connections: the server URL to give an agent, and every agent holding
 * access, each one disconnectable. Drawn only for an account MCP is open to — an
 * internal owner — so nobody else's Settings changes.
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
                Add this URL as a custom connector in Claude, or to any MCP client. It can list and read your
                own pages that are served on NML, and nothing else — it cannot change anything.
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
    </section>
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
  createdAt,
  lastUsedAt,
}: {
  grantId: Id<"mcpGrants">;
  clientName: string;
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
          Connected {WHEN.format(createdAt)}
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
