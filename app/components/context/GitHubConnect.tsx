"use client";

import { useState } from "react";
import { Brandmark } from "@/app/components/Brand";
import { GitHubMark } from "./marks";
import { PasteToken } from "./GitHubPicker";

/**
 * Not connected to GitHub yet: GitHub's mark, ours, a line between them, and
 * the button that joins them — `NotionConnect`, for the other door. It
 * connects in a window of its own, so the form this page came from is still
 * there when it closes. A pasted token stays one quiet link away, for an
 * organisation that will not approve the app.
 */
export function GitHubConnect({
  titleId,
  stale,
  blocker,
  onConnect,
}: {
  titleId: string;
  /** There was a connection and GitHub has since stopped accepting it. */
  stale: boolean;
  blocker: string | null;
  onConnect: () => void;
}) {
  const [pasting, setPasting] = useState(false);
  return (
    <div className="nt-nc">
      <div className="nt-nc-art" aria-hidden="true">
        <span className="nt-nc-tile">
          <GitHubMark width={28} height={28} />
        </span>
        <span className="nt-nc-track" />
        <span className="nt-nc-tile is-ours">
          <Brandmark width={24} height={30} />
        </span>
      </div>

      <h2 id={titleId} className="nt-nc-title">
        {stale ? "Reconnect your GitHub" : "Read your code into context"}
      </h2>
      {stale && (
        <p className="nt-nc-note">
          GitHub no longer accepts this connection. Reconnecting takes a moment.
        </p>
      )}

      {blocker ? (
        <p className="nt-note nt-nc-blocker">{blocker}</p>
      ) : (
        <>
          <button type="button" className="nt-nc-go" onClick={onConnect}>
            <GitHubMark width={15} height={15} />
            {stale ? "Reconnect GitHub" : "Connect GitHub"}
          </button>
          {pasting ? (
            <div className="nt-nc-paste">
              <PasteToken />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPasting(true)}
              className="nt-nc-alt"
            >
              Use a personal access token instead
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A workspace that reads code only through its GitHub App, before anyone has
 * installed it: the same two marks with nothing yet between them. An admin
 * installs it here, in a window of its own like connecting, so the form
 * behind is kept; the list arrives when the installation does. Anyone else
 * is told who can.
 */
export function GitHubAppMissing({
  titleId,
  canInstall,
  unconfigured,
  onInstall,
}: {
  titleId: string;
  canInstall: boolean;
  unconfigured: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="nt-nc">
      <div className="nt-nc-art" aria-hidden="true">
        <span className="nt-nc-tile">
          <GitHubMark width={28} height={28} />
        </span>
        <span className="nt-nc-track" />
        <span className="nt-nc-tile is-ours">
          <Brandmark width={24} height={30} />
        </span>
      </div>
      <h2 id={titleId} className="nt-nc-title">
        {unconfigured ? "GitHub isn’t available in this workspace yet" : "Install the GitHub App to read this workspace’s code"}
      </h2>
      <p className="nt-nc-note">
        {unconfigured
          ? "The GitHub App isn’t set up on this deployment, so no repository can be linked here yet."
          : canInstall
            ? "Choose which repositories on your GitHub organisation or account it may read. It never writes to them."
            : "Only an owner or admin can install it. Ask one of them."}
      </p>
      {canInstall && (
        <button type="button" className="nt-nc-go" onClick={onInstall}>
          <GitHubMark width={15} height={15} />
          Install the Nootles GitHub App
        </button>
      )}
    </div>
  );
}
