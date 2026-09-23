"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Listed } from "@/convex/github/repos";
import type { PageNode } from "@/convex/notion/pages";
import { reason } from "@/app/lib/github";
import { Check } from "../Icons";
import { NotionConnect } from "../notion/NotionConnect";
import { ProgressBar } from "../notion/Progress";
import { matchingPages, NotionPageTree } from "../notion/NotionPageTree";
import { PaletteShell, PALETTE_TITLE_ID } from "../notion/PaletteShell";
import { openConnectWindow } from "./connectWindow";
import { GitHubAppMissing, GitHubConnect } from "./GitHubConnect";
import { installPath, type GitHubDoor } from "./useGitHubDoor";
import type { NotionChoice } from "./NotionPicker";
import "./sources.css";

/**
 * The GitHub and Notion doors of the new-project dialog, each a page of the
 * palette: the room to choose several at once, searched from the palette's own
 * field. Each opens with what the project already has ticked, so the page is
 * the whole choice: confirming steps back to the project's details with
 * exactly what is ticked among its cards, and Back changes nothing.
 */

const Leave = ({ onClick }: { onClick: () => void }) => (
  <button type="button" onClick={onClick} className="nt-row px-2.5">
    Back
  </button>
);

/**
 * The import's wait, drawn the same: one bar while the connection is asked
 * after and the list is fetched, so the two read as one wait — and the words
 * only once there is a list being fetched, never before it is known there is
 * a connection to fetch it with.
 */
function Reading({ what, fetching, onBack }: { what: string; fetching: boolean; onBack: () => void }) {
  return (
    <PaletteShell said={fetching ? `Reading your ${what}` : ""} title="" foot={<Leave onClick={onBack} />}>
      <div className="nt-pal-reading">
        <div className="nt-pal-reading-bar">
          <ProgressBar label={`Reading your ${what}`} />
          {fetching && <p aria-hidden>Fetching {what}…</p>}
        </div>
      </div>
    </PaletteShell>
  );
}

export function GitHubSourcePage({
  door,
  chosen,
  search,
  onChoose,
  onBack,
}: {
  /** Where the project's repositories come from (`useGitHubDoor`). */
  door: GitHubDoor;
  /** What the project has now — ticked when the page opens. */
  chosen: readonly Listed[];
  search: string;
  onChoose: (repos: Listed[]) => void;
  onBack: () => void;
}) {
  if (door.via === "loading") return <Reading what="repositories" fetching={false} onBack={onBack} />;
  if (door.via === "shut") {
    return (
      <PaletteShell said="The GitHub App is not installed." title="" foot={<Leave onClick={onBack} />}>
        <GitHubAppMissing
          titleId={PALETTE_TITLE_ID}
          canInstall={door.canInstall}
          unconfigured={door.unconfigured}
          onInstall={() => openConnectWindow(installPath(door.workspaceId))}
        />
      </PaletteShell>
    );
  }
  if (door.via === "personal" && (!door.account || door.account.invalidAt)) {
    return (
      <PaletteShell said="GitHub is not connected." title="" foot={<Leave onClick={onBack} />}>
        <GitHubConnect
          titleId={PALETTE_TITLE_ID}
          stale={!!door.account?.invalidAt}
          blocker={door.ready ? null : door.blocker}
          onConnect={() => openConnectWindow("/api/github/connect")}
        />
      </PaletteShell>
    );
  }
  return (
    <Repositories
      through={door.via === "app" ? { app: door.workspaceId } : { forWorkspace: door.forWorkspace }}
      chosen={chosen}
      search={search}
      onChoose={onChoose}
      onBack={onBack}
    />
  );
}

/**
 * What the list is read through: a workspace's GitHub App installations, or
 * the person's own connection — for a workspace project, only until its App
 * is installed.
 */
type Through = { app: Id<"workspaces"> } | { forWorkspace: boolean };

function Repositories({
  through,
  chosen,
  search,
  onChoose,
  onBack,
}: {
  through: Through;
  chosen: readonly Listed[];
  search: string;
  onChoose: (repos: Listed[]) => void;
  onBack: () => void;
}) {
  const personal = useAction(api.github.repos.available);
  const installed = useAction(api.github.app.available);
  const lookup = useAction(api.github.repos.lookup);
  const [list, setList] = useState<Listed[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, Listed>>(
    () => new Map(chosen.map((r) => [r.fullName, r])),
  );
  const app = "app" in through ? through.app : null;

  // Asked once per visit: a call outside React, made when the page opens.
  useEffect(() => {
    let alive = true;
    (app ? installed({ workspaceId: app }) : personal({}))
      .then((rows) => alive && setList(rows))
      .catch((error) => alive && setFailure(reason(error)));
    return () => {
      alive = false;
    };
  }, [app, installed, personal]);

  const typed = search.trim();
  const shown = (list ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(typed.toLowerCase()),
  );
  // A repository the page of recents did not reach looks like a typo until
  // GitHub is asked for it by name. An installation's list is already the
  // whole of what it may read.
  const nameable =
    !app && /^[\w.-]+\/[\w.-]+$/.test(typed) && !shown.some((r) => r.fullName === typed);

  const toggle = (repo: Listed) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(repo.fullName)) next.delete(repo.fullName);
      else next.set(repo.fullName, repo);
      return next;
    });

  const byName = async () => {
    setFailure(null);
    try {
      const repo = await lookup({ fullName: typed });
      if (!repo) setFailure(`GitHub has no repository at “${typed}” that this connection can see.`);
      else {
        setList((rows) => (rows?.some((r) => r.fullName === repo.fullName) ? rows : [repo, ...(rows ?? [])]));
        setPicked((prev) => new Map(prev).set(repo.fullName, repo));
      }
    } catch (error) {
      setFailure(reason(error));
    }
  };

  const add = () => onChoose([...picked.values()]);

  if (!list && !failure) return <Reading what="repositories" fetching onBack={onBack} />;

  return (
    <PaletteShell
      said={list ? `${shown.length} repositories` : "Reading your repositories"}
      title="Choose repositories to read into context"
      note={
        app
          ? "Read through the workspace’s GitHub App, which never writes to them."
          : "forWorkspace" in through && through.forWorkspace
            ? "Read with your own GitHub connection until the workspace installs its GitHub App. Nootles never writes to them."
            : "Nootles reads what you link and never writes to it."
      }
      flush
      foot={
        <>
          {failure ? (
            <span role="alert" className="min-w-0 flex-1 truncate text-danger">
              {failure}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <Leave onClick={onBack} />
          <button
            type="button"
            onClick={add}
            className="nt-row nt-solid px-3 font-medium"
          >
            {picked.size ? `Add ${picked.size} ${picked.size === 1 ? "repository" : "repositories"}` : "Done"}
          </button>
        </>
      }
    >
      <div
        className="nt-srcpage-list"
        role="listbox"
        aria-multiselectable
        aria-label="Repositories"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            add();
          }
        }}
      >
        {nameable && (
          <button type="button" className="nt-srcpage-row" onClick={() => void byName()}>
            <span className="nt-srcpage-text">
              <span className="nt-srcpage-name">Look up “{typed}” on GitHub</span>
            </span>
          </button>
        )}
        {list && !shown.length && !nameable && (
          <p className="nt-srcpage-empty">
            {typed
              ? app
                ? "Nothing matches among the repositories the GitHub App reads."
                : "Nothing matches. Type the full owner/name to fetch it directly."
              : app
                ? "The GitHub App can’t read any repositories yet. An admin chooses which on GitHub."
                : "This connection cannot see any repositories."}
          </p>
        )}
        {shown.map((repo) => {
          const on = picked.has(repo.fullName);
          return (
            <button
              key={repo.fullName}
              type="button"
              role="option"
              aria-selected={on}
              className="nt-srcpage-row"
              onClick={() => toggle(repo)}
            >
              <span className="nt-notion-box" data-state={on ? "on" : "off"}>
                {on && <Check />}
              </span>
              <span className="nt-srcpage-text">
                <span className="nt-srcpage-name">{repo.fullName}</span>
                <span className="nt-srcpage-meta">
                  {[repo.private ? "Private" : "Public", repo.description].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </PaletteShell>
  );
}

export function NotionSourcePage({
  chosen,
  search,
  onChoose,
  onBack,
}: {
  chosen: readonly NotionChoice[];
  search: string;
  onChoose: (pages: NotionChoice[]) => void;
  onBack: () => void;
}) {
  const status = useQuery(api.notion.account.status);
  const connected = !!status?.account && !status.account.invalidAt;

  if (!status) return <Reading what="Notion pages" fetching={false} onBack={onBack} />;
  if (!connected) {
    return (
      <PaletteShell said="Notion is not connected." title="" foot={<Leave onClick={onBack} />}>
        <NotionConnect
          titleId={PALETTE_TITLE_ID}
          stale={!!status.account?.invalidAt}
          blocker={status.ready ? null : status.blocker}
          title="Read your Notion pages into context"
          onConnect={() => openConnectWindow("/api/notion/connect")}
        />
      </PaletteShell>
    );
  }
  return <NotionPages chosen={chosen} search={search} onChoose={onChoose} onBack={onBack} />;
}

function NotionPages({
  chosen,
  search,
  onChoose,
  onBack,
}: {
  chosen: readonly NotionChoice[];
  search: string;
  onChoose: (pages: NotionChoice[]) => void;
  onBack: () => void;
}) {
  const listPages = useAction(api.notion.pages.listPages);
  const [tree, setTree] = useState<PageNode[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Starts from what the project already has, so the ticks say where it stands.
  const [selection, setSelection] = useState<ReadonlySet<string>>(
    () => new Set(chosen.map((p) => p.pageId)),
  );

  useEffect(() => {
    let alive = true;
    listPages({})
      .then((pages) => alive && setTree(pages))
      .catch((error) => alive && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      alive = false;
    };
  }, [listPages]);

  const shown = useMemo(() => matchingPages(tree ?? [], search), [tree, search]);
  const byId = useMemo(() => new Map(walk(tree ?? []).map((p) => [p.id, p])), [tree]);
  const ticked = [...selection];

  const add = () => {
    const kept = new Map(chosen.map((p) => [p.pageId, p]));
    onChoose(
      ticked.flatMap((id): NotionChoice[] => {
        const page = byId.get(id);
        // A page no longer shared is not in the tree, so it cannot be unticked
        // here — it stays as it was chosen.
        if (!page) return kept.has(id) ? [kept.get(id)!] : [];
        return [{ pageId: page.id, title: page.title || "Untitled", ...(page.emoji ? { emoji: page.emoji } : {}) }];
      }),
    );
  };

  if (!tree && !failure) return <Reading what="Notion pages" fetching onBack={onBack} />;

  return (
    <PaletteShell
      said="Notion pages"
      title="Choose pages to read into context"
      note="Ticking a page takes the pages inside it. They stay in Notion."
      flush
      foot={
        <>
          {failure ? (
            <span role="alert" className="min-w-0 flex-1 truncate text-danger">
              {failure}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => openConnectWindow("/api/notion/connect")}
              className="min-w-0 flex-1 truncate text-left text-muted underline underline-offset-2 hover:text-foreground"
            >
              Share more pages with Nootles
            </button>
          )}
          <Leave onClick={onBack} />
          <button
            type="button"
            onClick={add}
            className="nt-row nt-solid px-3 font-medium"
          >
            {ticked.length ? `Add ${ticked.length} ${ticked.length === 1 ? "page" : "pages"}` : "Done"}
          </button>
        </>
      }
    >
      {tree && !tree.length && <p className="nt-srcpage-empty">No pages are shared with Nootles yet.</p>}
      {tree && tree.length > 0 && (
        <NotionPageTree
          nodes={shown}
          selection={selection}
          setSelection={setSelection}
          forceOpen={!!search}
          palette
          label="Notion pages to read into context"
        />
      )}
    </PaletteShell>
  );
}

function walk(nodes: PageNode[]): PageNode[] {
  return nodes.flatMap((page) => [page, ...walk(page.children)]);
}
