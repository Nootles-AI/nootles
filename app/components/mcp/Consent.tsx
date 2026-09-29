"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Wordmark } from "@/app/components/Brand";
import "../settings/settings.css";
import "./mcp.css";

const REFUSALS = {
  "not-internal": "Only internal accounts can connect agents for now.",
  "mcp-off": "Connecting agents is off right now.",
  "stand-in": "You can’t connect an agent while standing in for someone.",
} as const;

/**
 * The one question an MCP sign-in asks a person. The page says what is granted
 * in both directions — what the agent will see and do, and what it will not —
 * and names where the answer goes, because a registered client can call itself
 * anything but cannot change where it is redirected. Editing is its own line
 * with its own switch: an agent that asks to write can still be let in to read.
 */
export function Consent({ request }: { request: string | null }) {
  const pending = useQuery(api.mcp.oauth.pendingRequest, request ? { request } : "skip");
  const approve = useAction(api.mcp.oauth.approve);
  const deny = useMutation(api.mcp.oauth.deny);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [allowEdits, setAllowEdits] = useState(true);
  const asksToEdit = pending?.status === "pending" && pending.scope.split(" ").includes("docs:write");

  const allow = async () => {
    if (!request) return;
    setBusy("allow");
    setProblem(null);
    try {
      const outcome = await approve({ request, allowEdits: asksToEdit && allowEdits });
      if (outcome.status === "redirect") {
        setLeaving(true);
        window.location.assign(outcome.redirectTo);
        return;
      }
      setProblem(
        outcome.reason === "expired"
          ? "This request expired. Try again from your agent."
          : REFUSALS[outcome.reason],
      );
    } catch {
      setProblem("That didn’t work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!request) return;
    setBusy("deny");
    try {
      const outcome = await deny({ request });
      if (outcome) {
        setLeaving(true);
        window.location.assign(outcome.redirectTo);
        return;
      }
      window.location.assign("/");
    } catch {
      setProblem("That didn’t work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="nt-set-page">
      <header className="nt-set-topbar">
        <Link href="/" aria-label="Nootles">
          <Wordmark height={18} />
        </Link>
      </header>
      <main className="nt-set-body nt-mcp-consent" aria-busy={pending === undefined}>
        {!request || pending?.status === "missing" ? (
          <>
            <h1 className="nt-set-title">Link expired</h1>
            <p className="nt-set-note nt-mcp-lede">
              Try connecting again from your agent.
            </p>
          </>
        ) : pending ? (
          <>
            <h1 className="nt-set-title">Connect {pending.clientName}?</h1>
            <p className="nt-set-note nt-mcp-lede">
              <span className="nt-mcp-client">{pending.clientName}</span> wants to{" "}
              {asksToEdit ? "read and edit" : "read"} your pages.
            </p>

            <ul className="nt-set-list nt-mcp-card">
              <li className="nt-mcp-item">
                <span className="nt-mcp-mark is-yes" aria-hidden>
                  ✓
                </span>
                <span>See and read your own pages</span>
              </li>
              {asksToEdit ? (
                <li>
                  <label className="nt-mcp-item nt-mcp-choice">
                    <input
                      type="checkbox"
                      checked={allowEdits}
                      onChange={(event) => setAllowEdits(event.target.checked)}
                      disabled={busy !== null || leaving}
                    />
                    <span>
                      <strong>Allow edits</strong> to your own pages. Each one shows on the page, marked as{" "}
                      {pending.clientName}’s, and you can undo it.
                    </span>
                  </label>
                </li>
              ) : (
                <li className="nt-mcp-item">
                  <span className="nt-mcp-mark" aria-hidden>
                    ✕
                  </span>
                  <span>Edit anything</span>
                </li>
              )}
              <li className="nt-mcp-item">
                <span className="nt-mcp-mark" aria-hidden>
                  ✕
                </span>
                <span>See team or shared pages</span>
              </li>
            </ul>

            <p className="nt-set-meta nt-mcp-where">
              Returns to <span className="nt-mcp-origin">{pending.redirectOrigin}</span>
            </p>

            {pending.refusal && (
              <p role="alert" className="nt-set-problem">
                {REFUSALS[pending.refusal]}
              </p>
            )}
            {problem && (
              <p role="alert" className="nt-set-problem">
                {problem}
              </p>
            )}

            <div className="nt-mcp-actions">
              {/* The safe answer first, as everywhere: Enter on arrival refuses. */}
              <button type="button" onClick={cancel} disabled={busy !== null || leaving} autoFocus className="nt-row px-3">
                {busy === "deny" ? "Cancelling…" : "Cancel"}
              </button>
              {!pending.refusal && (
                <button
                  type="button"
                  onClick={allow}
                  disabled={busy !== null || leaving}
                  className="nt-row nt-solid px-3 font-medium"
                >
                  {leaving
                    ? `Returning to ${pending.clientName}…`
                    : busy === "allow"
                      ? "Connecting…"
                      : asksToEdit && !allowEdits
                        ? "Allow reading"
                        : "Allow"}
                </button>
              )}
            </div>
            {!pending.refusal && (
              <p className="nt-set-note nt-mcp-foot">
                Disconnect anytime in{" "}
                <Link href="/settings" className="underline">
                  Settings
                </Link>
                .
              </p>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
