"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Account } from "@/convex/notion/account";
import { Wordmark } from "@/app/components/Brand";
import { DialogBox } from "@/app/components/Dialog";
import { X } from "@/app/components/Icons";
import { NotionMark } from "@/app/components/NotionMark";
import {
  describeOutcome,
  useNotionOutcome,
  type NotionOutcome,
} from "@/app/lib/notion/outcome";
import "./settings.css";

/**
 * The account's standing arrangements — for now, the one connection it holds.
 *
 * A page with a URL rather than a tab in a dialog, because a connection is
 * something you come back to months later to check or to end, and the only
 * other place it appeared was inside the import flow: a thing you can only
 * reach by starting an import is a thing you cannot find when you want to
 * stop one. It is also where `/api/notion/connect` sends you back to when you
 * started from here, which is why the outcome line lives on this row.
 */
export function Settings() {
  const status = useQuery(api.notion.account.status, {});
  const outcome = useNotionOutcome();

  return (
    <div className="nt-set-page">
      <header className="nt-set-topbar">
        <Link href="/" aria-label="Nootles">
          <Wordmark height={18} />
        </Link>
        <Link href="/" className="nt-note hover:underline">
          Back to your projects
        </Link>
      </header>
      <main className="nt-set-body">
        <h1 className="nt-set-title">Settings</h1>
        <section
          className="nt-set-section"
          aria-labelledby="nt-set-integrations"
          aria-busy={!status}
        >
          <h2 id="nt-set-integrations" className="nt-set-label">
            Integrations
          </h2>
          {/* Nothing until the status is in: rendering "Connect Notion" while
              the query is in flight offers it for an instant to people who
              connected months ago, and an empty card is a skeleton by another
              name. */}
          {status && (
            <ul className="nt-set-list">
              <li>
                <NotionRow
                  ready={status.ready}
                  blocker={status.blocker}
                  account={status.account}
                  outcome={outcome.outcome}
                  reason={outcome.reason}
                  onDismiss={outcome.dismiss}
                />
              </li>
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

const CONNECT = `/api/notion/connect?returnTo=${encodeURIComponent("/settings")}`;

const WHEN = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function NotionRow({
  ready,
  blocker,
  account,
  outcome,
  reason,
  onDismiss,
}: {
  ready: boolean;
  blocker: string;
  account: Account | null;
  outcome: NotionOutcome | null;
  reason: string | null;
  onDismiss: () => void;
}) {
  const revoked = !!account?.invalidAt;
  // Focusable so a disconnect has somewhere to leave focus once the button
  // that started it is gone.
  const row = useRef<HTMLDivElement>(null);
  // "Notion connected." under a row that has since been disconnected would
  // be a report about a connection that no longer exists.
  const line =
    outcome && !(outcome === "connected" && !account) ? describeOutcome(outcome, reason) : null;

  return (
    <div className="nt-set-row" ref={row} tabIndex={-1}>
      <span className="nt-set-glyph">
        <NotionMark />
      </span>
      <div className="nt-set-body-col">
        <div className="nt-set-name">Notion</div>
        {account ? (
          <>
            <div className="nt-set-workspace">
              <WorkspaceIcon icon={account.workspaceIcon} />
              <span>{account.workspaceName}</span>
            </div>
            <div className="nt-set-meta">
              Connected {WHEN.format(account.connectedAt)} · ····{account.hint}
            </div>
            {revoked && (
              <p className="nt-set-problem">
                Notion no longer accepts this connection. Reconnect to import
                pages again.
              </p>
            )}
            {!ready && <p className="nt-set-problem">{blocker}</p>}
          </>
        ) : ready ? (
          <p className="nt-set-note">
            Not connected. Connect a workspace to import its pages, choosing
            which ones Nootles can see.
          </p>
        ) : (
          <p className="nt-set-problem">{blocker}</p>
        )}
        {line && (
          <div
            role={line.problem ? "alert" : "status"}
            className={`nt-set-outcome ${line.problem ? "nt-set-problem" : "nt-set-note"}`}
          >
            <span>{line.text}</span>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="nt-icon-btn is-sm"
            >
              <X />
            </button>
          </div>
        )}
      </div>
      <div className="nt-set-actions">
        {account ? (
          <>
            {/* Both need the deployment able to seal a token; without the
                key the only thing this row can still do is let go. */}
            {ready &&
              (revoked ? (
                <a href={CONNECT} className="nt-row nt-solid px-3 font-medium">
                  Reconnect
                </a>
              ) : (
                <a href={CONNECT} className="nt-row px-2.5">
                  Grant more pages
                </a>
              ))}
            <Disconnect
              workspace={account.workspaceName}
              onDone={() => row.current?.focus()}
            />
          </>
        ) : (
          ready && (
            <a href={CONNECT} className="nt-row nt-solid px-3 font-medium">
              Connect Notion
            </a>
          )
        )}
      </div>
    </div>
  );
}

/** Notion hands over either an emoji or an address, and says nothing about which. */
function WorkspaceIcon({ icon }: { icon: string | undefined }) {
  if (!icon) return null;
  if (/^https?:\/\//.test(icon)) {
    return (
      // Not next/image: Notion serves workspace icons from whichever bucket it
      // uploaded them to, and the optimizer would need each host whitelisted.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={icon} alt="" width={16} height={16} className="nt-set-workspace-icon" />
    );
  }
  return (
    <span className="nt-set-workspace-emoji" aria-hidden>
      {icon}
    </span>
  );
}

/**
 * Letting go of the connection. Confirmed, because the button sits an inch
 * from "Grant more pages" and the two are answers to opposite questions — but
 * confirmed with the sentence that matters, which is that nothing already
 * imported goes with it.
 */
function Disconnect({ workspace, onDone }: { workspace: string; onDone: () => void }) {
  const disconnect = useMutation(api.notion.account.disconnect);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const cancel = useCallback(() => setConfirming(false), []);
  const confirm = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await disconnect({});
      setConfirming(false);
      // This button is about to unmount with the account; focus is handed on
      // before the dialog's own restore can look for it.
      onDone();
    } catch {
      setFailure("The connection could not be removed. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} className="nt-row px-2.5">
        Disconnect
      </button>
      {confirming && (
        <DialogBox label="Disconnect Notion" onClose={cancel}>
          <p className="text-sm font-medium">Disconnect Notion?</p>
          <p className="mt-1.5 text-[13px] text-muted">
            Nootles forgets its access to {workspace}. Pages already imported
            stay in Nootles; importing more means connecting again.
          </p>
          {failure && (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {failure}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-1">
            {/* The safe answer lands first: Enter on arrival keeps the
                connection, and the destructive one is a deliberate step on. */}
            <button type="button" onClick={cancel} autoFocus className="nt-row px-2.5">
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              className="nt-row px-2.5 font-medium"
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </DialogBox>
      )}
    </>
  );
}
