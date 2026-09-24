"use client";

import { useState } from "react";
import Link from "next/link";
import type { Id } from "@/convex/_generated/dataModel";
import { Brandmark } from "@/app/components/Brand";
import { GitHubMark } from "./marks";
import { PasteToken } from "./GitHubPicker";
import { useIntegrationsPath, useMembersPath } from "./useGitHubDoor";

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
 * is told who can, and what to add meanwhile.
 *
 * Where this deployment has no App at all, the door is shut only because the
 * workspace turned personal connections off, so that is what it says: to an
 * owner or admin, with the way back; to anyone else, who chose it.
 */
export function GitHubAppMissing({
  titleId,
  workspaceId,
  canInstall,
  manages,
  unconfigured,
  onInstall,
}: {
  titleId: string;
  workspaceId: Id<"workspaces">;
  canInstall: boolean;
  manages: boolean;
  unconfigured: boolean;
  onInstall: () => void;
}) {
  const settings = useIntegrationsPath(workspaceId);
  // Anyone who can do nothing here is shown who can, rather than left at a wall.
  const people = useMembersPath(workspaceId);
  const said = unconfigured
    ? manages
      ? {
          title: "Personal connections are off",
          note: "This workspace links code only through the GitHub App, which can’t be set up here. Turn personal GitHub connections back on to link repositories.",
        }
      : {
          title: "GitHub is turned off here",
          note: "An owner or admin turned off personal GitHub connections for this workspace. Upload files or add Notion pages instead.",
        }
    : canInstall
      ? {
          title: "Install the GitHub App",
          note: "It reads this workspace’s code: only the repositories you choose, and never writes to them.",
        }
      : {
          title: "The GitHub App isn’t installed",
          note: "An owner or admin installs it from Settings › Integrations. Until then, upload files or add Notion pages.",
        };
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
        {said.title}
      </h2>
      <p className="nt-nc-note">{said.note}</p>
      {canInstall && (
        <button type="button" className="nt-nc-go" onClick={onInstall}>
          <GitHubMark width={15} height={15} />
          Install the Nootles GitHub App
        </button>
      )}
      {unconfigured && manages && settings && (
        <Link href={settings} className="nt-nc-alt">
          Open Settings › Integrations
        </Link>
      )}
      {!manages && people && (
        <Link href={people} className="nt-nc-alt">
          {unconfigured ? "See who can turn it back on" : "See who can install it"}
        </Link>
      )}
    </div>
  );
}
