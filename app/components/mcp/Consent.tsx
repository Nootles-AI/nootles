"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Wordmark } from "@/app/components/Brand";
import "../settings/settings.css";
import "./mcp.css";

const REFUSALS = {
  "not-internal": "Connecting agents is limited to Nootles’ internal accounts for now.",
  "mcp-off": "Connecting agents is turned off right now. Try again later.",
  "stand-in": "You are viewing this account as someone else, so an agent cannot be connected to it.",
} as const;

/**
 * The one question an MCP sign-in asks a person. Read-only is the whole of
 * what is granted, so the page says what that means in both directions — what
 * the agent will see and what it will not — and names where the answer goes,
 * because a registered client can call itself anything but cannot change where
 * it is redirected.
 */
export function Consent({ request }: { request: string | null }) {
  const pending = useQuery(api.mcp.oauth.pendingRequest, request ? { request } : "skip");
  const approve = useAction(api.mcp.oauth.approve);
  const deny = useMutation(api.mcp.oauth.deny);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const allow = async () => {
    if (!request) return;
    setBusy("allow");
    setProblem(null);
    try {
      const outcome = await approve({ request });
      if (outcome.status === "redirect") {
        setLeaving(true);
        window.location.assign(outcome.redirectTo);
        return;
      }
      setProblem(
        outcome.reason === "expired"
          ? "This request has expired. Start the connection again from your agent."
          : REFUSALS[outcome.reason],
      );
    } catch {
      setProblem("That did not go through. Try again in a moment.");
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
      setProblem("That did not go through. Try again in a moment.");
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
            <h1 className="nt-set-title">This link has expired</h1>
            <p className="nt-set-note nt-mcp-lede">
              A connection request lasts ten minutes and can be answered once. Start the connection again
              from your agent to get a fresh one.
            </p>
          </>
        ) : pending ? (
          <>
            <h1 className="nt-set-title">Connect {pending.clientName}?</h1>
            <p className="nt-set-note nt-mcp-lede">
              <span className="nt-mcp-client">{pending.clientName}</span> is asking to read your Nootles pages.
            </p>

            <ul className="nt-set-list nt-mcp-card">
              <li className="nt-mcp-item">
                <span className="nt-mcp-mark is-yes" aria-hidden>
                  ✓
                </span>
                <span>
                  See and read <strong>your own pages</strong> that are served from the NML document tree
                </span>
              </li>
              <li className="nt-mcp-item">
                <span className="nt-mcp-mark" aria-hidden>
                  ✕
                </span>
                <span>Change, create or delete anything — access is read-only</span>
              </li>
              <li className="nt-mcp-item">
                <span className="nt-mcp-mark" aria-hidden>
                  ✕
                </span>
                <span>See pages in a team workspace, pages shared with you, or pages not yet on NML</span>
              </li>
            </ul>

            <p className="nt-set-meta nt-mcp-where">
              Answers go to <span className="nt-mcp-origin">{pending.redirectOrigin}</span>
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
                  {leaving ? `Returning to ${pending.clientName}…` : busy === "allow" ? "Connecting…" : "Allow read access"}
                </button>
              )}
            </div>
            {!pending.refusal && (
              <p className="nt-set-note nt-mcp-foot">
                You can disconnect it at any time from{" "}
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
