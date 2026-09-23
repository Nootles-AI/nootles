"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Listed } from "@/convex/github/repos";
import { appAndOwn, reason } from "@/app/lib/github";
import { openConnectWindow } from "./connectWindow";
import { PickerReading } from "./PickerReading";
import { GitHubMark } from "./marks";
import { installPath, useGitHubDoor, type GitHubDoor } from "./useGitHubDoor";
import { useContainer } from "../workspaces/ContainerContext";

/**
 * Choosing a repository from GitHub, connecting first if there is no account
 * yet — the GitHub door of the context sources (`ContextSources`). In a
 * workspace's project the repositories are its GitHub App's
 * (`useGitHubDoor`).
 */
export function GitHubPicker({
  linked,
  onPick,
  onDone,
}: {
  linked: ReadonlySet<string>;
  onPick: (repo: Listed) => void;
  onDone: () => void;
}) {
  const here = useContainer();
  const door = useGitHubDoor(here.kind === "workspace" ? here.workspaceId : undefined);
  // The deployment cannot hold a secret yet, nobody has connected one, or there
  // is a token and the question is which repository — three states, and only
  // the last of them is a picker. Nothing at all until the answer is in:
  // rendering the connect step while the query is in flight offers it for an
  // instant to people who connected months ago.
  if (door.via === "loading") return <PickerReading label="Reading your repositories" />;
  if (door.via === "shut") return <AppMissing door={door} />;
  if (door.via === "app") {
    return (
      <Picker linked={linked} app={door.workspaceId} own={door.personal} onPick={onPick} onDone={onDone} />
    );
  }
  if (!door.ready) return <p className="nt-note">{door.blocker}</p>;
  if (!door.account) return <Connect />;
  return (
    <Picker
      linked={linked}
      account={{ login: door.account.login, hint: door.account.hint, stale: !!door.account.invalidAt }}
      onPick={onPick}
      onDone={onDone}
    />
  );
}

/** The picker's size of `GitHubAppMissing`: who can install the App, and the press that does. */
function AppMissing({ door }: { door: Extract<GitHubDoor, { via: "shut" }> }) {
  return (
    <div className="nt-picker p-2.5">
      {door.canInstall && (
        <button
          type="button"
          onClick={() => openConnectWindow(installPath(door.workspaceId))}
          className="nt-row nt-solid w-full justify-center gap-2 px-3 font-medium"
        >
          <GitHubMark width={14} height={14} />
          Install the Nootles GitHub App
        </button>
      )}
      <p className={`nt-note${door.canInstall ? " mt-2" : ""}`}>
        {door.unconfigured
          ? "GitHub isn’t available in this workspace yet: the GitHub App isn’t set up on this deployment."
          : door.canInstall
            ? "Install the GitHub App to read this workspace’s code. It reads only the repositories you choose on your organisation or account, and never writes to them."
            : "Install the GitHub App to read this workspace’s code. Only an owner or admin can install it. Ask one of them."}
      </p>
    </div>
  );
}

/**
 * Choosing a repository.
 *
 * The list is one page of what the token can see, most recently pushed first —
 * which is the right hundred for a person, and nowhere near all of them for an
 * organisation. So the field doubles as a lookup: type a full "owner/name" and
 * it is fetched by name, whether or not it was on the list. An installation's
 * list is all of what it reads, so through the App there is a lookup only
 * where the person's own connection may fill in what the App doesn't reach.
 */
function Picker({
  linked,
  app,
  own = false,
  account,
  onPick,
  onDone,
}: {
  linked: ReadonlySet<string>;
  /** Listed through this workspace's GitHub App rather than an account. */
  app?: Id<"workspaces">;
  /** Beside the App's, the person's own repositories, and a lookup with their connection. */
  own?: boolean;
  account?: { login: string; hint: string; stale: boolean };
  onPick: (repo: Listed) => void;
  onDone: () => void;
}) {
  const available = useAction(api.github.repos.available);
  const installed = useAction(api.github.app.available);
  const lookup = useAction(api.github.repos.lookup);
  const disconnect = useMutation(api.github.account.disconnect);

  const [list, setList] = useState<Listed[] | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  // The one thing this component does on arrival: ask GitHub what there is.
  // An effect because it is a call to something outside React, and it mounts
  // only when the add button is pressed, so it runs once per picking.
  useEffect(() => {
    let alive = true;
    (app
      ? own
        ? appAndOwn(installed({ workspaceId: app }), available({}))
        : installed({ workspaceId: app })
      : available({})
    )
      .then((rows) => alive && setList(rows))
      .catch((error) => alive && setFailure(reason(error)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [app, own, available, installed]);

  const typed = filter.trim();
  const shown = (list ?? []).filter(
    (repo) => !linked.has(repo.fullName) && repo.fullName.toLowerCase().includes(typed.toLowerCase()),
  );
  // Worth offering the moment it is a plausible name — an org repo the page of
  // recents did not reach looks exactly like a typo until you ask GitHub.
  const nameable =
    (!app || own) && /^[\w.-]+\/[\w.-]+$/.test(typed) && !shown.some((r) => r.fullName === typed);

  const byName = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const found = await lookup({ fullName: typed });
      // Where the App reads it too, the App's row: that is what it's read with.
      const repo = found && (list?.find((r) => r.fullName.toLowerCase() === found.fullName.toLowerCase()) ?? found);
      if (!repo) setFailure(`GitHub has no repository at “${typed}” that this token can see.`);
      else if (linked.has(repo.fullName)) setFailure(`${repo.fullName} is already linked.`);
      else onPick(repo);
    } catch (error) {
      setFailure(reason(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nt-picker">
      <div className="p-1.5">
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onDone();
            }
            // Always swallowed, whether or not there is anything to look up:
            // this field lives inside the new-project dialog's form, where a
            // stray Enter would create the project mid-sentence.
            if (e.key === "Enter") {
              e.preventDefault();
              if (nameable) void byName();
            }
          }}
          placeholder={app && !own ? "Filter the workspace’s repositories" : "Filter, or type owner/name"}
          aria-label="Find a repository"
          className="nt-input"
        />
      </div>

      <div className="nt-picker-list">
        {nameable && (
          <button
            type="button"
            disabled={busy}
            onClick={byName}
            className="nt-row w-full"
          >
            <span className="nt-row-label">Look up “{typed}” on GitHub</span>
          </button>
        )}
        {busy && !list && <PickerReading label="Reading your repositories" words="Fetching repositories…" />}
        {list && !shown.length && !nameable && (
          <p className="nt-picker-empty">
            {typed
              ? app && !own
                ? "Nothing matches among the repositories the GitHub App reads."
                : "Nothing matches. Type the full owner/name to fetch it directly."
              : app
                ? "The GitHub App can’t read any repositories yet. An admin chooses which on GitHub."
                : "This token cannot see any repositories."}
          </p>
        )}
        {shown.map((repo) => (
          <button
            key={repo.fullName}
            type="button"
            onClick={() => onPick(repo)}
            title={repo.description}
            className="nt-row w-full"
          >
            <span className="nt-row-label">{repo.fullName}</span>
            {repo.private && <span className="nt-field-note">Private</span>}
          </button>
        ))}
      </div>

      {failure && (
        <p role="alert" className="nt-picker-foot text-danger">
          {failure}
        </p>
      )}

      <div className="nt-picker-foot">
        {account ? (
          <>
            <span className="min-w-0 flex-1 truncate">
              {account.stale ? "Token rejected — " : ""}@{account.login} · ····{account.hint}
            </span>
            <button
              type="button"
              onClick={() => void disconnect({})}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Disconnect
            </button>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {own ? "Through the workspace’s GitHub App, or your own connection" : "Through the workspace’s GitHub App"}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Connecting GitHub: GitHub's own consent screen, in a window of its own
 * (`openConnectWindow`), so an unfinished new-project form survives it; the
 * picker appears the moment the token is sealed.
 *
 * A pasted token stays as the way in for an organisation that will not approve
 * the app: a classic token authorised for its SSO, or a fine-grained one where
 * the org permits them.
 */
function Connect() {
  const [pasting, setPasting] = useState(false);
  return (
    <div className="nt-picker p-2.5">
      <button
        type="button"
        onClick={() => openConnectWindow("/api/github/connect")}
        className="nt-row nt-solid w-full justify-center gap-2 px-3 font-medium"
      >
        <GitHubMark width={14} height={14} />
        Connect GitHub
      </button>
      <p className="nt-note mt-2">
        Nootles reads the repositories you link, and never writes to them.
      </p>
      {pasting ? (
        <PasteToken />
      ) : (
        <button
          type="button"
          onClick={() => setPasting(true)}
          className="nt-note mt-1.5 underline underline-offset-2 hover:text-foreground"
        >
          Use a personal access token instead
        </button>
      )}
    </div>
  );
}

export function PasteToken() {
  const connect = useAction(api.github.account.connect);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    connect({ token })
      .then(() => setToken(""))
      .catch((error) => setFailure(reason(error, "That token could not be verified.")))
      .finally(() => setBusy(false));
  };

  return (
    // Submitted by its own button: nested inside the new-project dialog's
    // form, an Enter here would otherwise create the project.
    <div className="mt-2.5 border-t border-border pt-2.5">
      <p className="nt-note">
        A classic token needs the <code className="nt-mono-inline">repo</code> scope,
        and “Configure SSO” on it to reach an organisation; a fine-grained one needs
        Contents: Read on the repositories you want.
      </p>
      <div className="mt-2 flex gap-1.5">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit(e);
          }}
          placeholder="ghp_… or github_pat_…"
          aria-label="GitHub personal access token"
          className="nt-input"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!token.trim() || busy}
          className="nt-row shrink-0 px-3 font-medium"
        >
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
      {failure && (
        <p role="alert" className="mt-2 text-[13px] leading-snug text-danger">
          {failure}
        </p>
      )}
    </div>
  );
}
