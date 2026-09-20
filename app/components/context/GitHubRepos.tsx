"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Listed } from "@/convex/github/repos";
import { reason } from "@/app/lib/github";
import { Plus, X } from "../Icons";

/**
 * The repositories a project is pointed at, and the one control that adds them.
 *
 * Controlled, because the two places it appears mean different things by
 * "added": in the new-project dialog the project does not exist yet and the
 * choices are held in memory until it does, and in the context view each one is
 * a row written the moment it is picked. Same component, same picker, two
 * owners of the list.
 */

/** A repository as this component draws one, whether or not it is saved yet. */
export type Chosen = {
  /** Whatever the owner of the list identifies a row by — an id, or the name. */
  key: string;
  fullName: string;
  description?: string;
  private: boolean;
  /** A second line: what the last read found, or why it failed. */
  note?: string;
  noteIsProblem?: boolean;
};

export function GitHubRepos({
  repos,
  onAdd,
  onRemove,
}: {
  repos: Chosen[];
  onAdd: (repo: Listed) => void;
  onRemove: (key: string) => void;
}) {
  const status = useQuery(api.github.account.status);
  const [picking, setPicking] = useState(false);

  const linked = new Set(repos.map((r) => r.fullName));

  return (
    <div>
      <div className="nt-field-label">
        Repositories
        <span className="nt-field-note">Optional</span>
      </div>

      {repos.length > 0 && (
        <ul className="mb-1">
          {repos.map((repo) => (
            <li key={repo.key} className="nt-repo">
              <span className="nt-repo-body">
                <span className="nt-repo-name">{repo.fullName}</span>
                <span
                  className={`nt-repo-note${repo.noteIsProblem ? " is-problem" : ""}`}
                >
                  {repo.note ?? repo.description ?? (repo.private ? "Private" : "Public")}
                </span>
              </span>
              <button
                type="button"
                onClick={() => onRemove(repo.key)}
                aria-label={`Remove ${repo.fullName}`}
                title="Remove"
                className="nt-icon-btn is-sm"
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}

      {picking ? (
        // The deployment cannot hold a secret yet, nobody has connected one, or
        // there is a token and the question is which repository — three states,
        // and only the last of them is a picker. Nothing at all until the answer
        // is in: rendering the connect form while the query is in flight offers
        // it for an instant to people who connected months ago.
        !status ? null : !status.ready ? (
          <p className="nt-note">{status.blocker}</p>
        ) : status.account ? (
          <Picker
            linked={linked}
            login={status.account.login}
            hint={status.account.hint}
            stale={!!status.account.invalidAt}
            onPick={(repo) => {
              onAdd(repo);
              setPicking(false);
            }}
            onDone={() => setPicking(false)}
          />
        ) : (
          <Connect />
        )
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="nt-row w-full text-muted"
        >
          <Plus />
          <span className="nt-row-label">
            {repos.length ? "Add another repository" : "Add a repository"}
          </span>
        </button>
      )}

      {!picking && repos.length === 0 && (
        <p className="nt-note mt-1.5">
          The assistant reads a linked repository’s files when it needs them, and
          knows what each one is without being told.
        </p>
      )}
    </div>
  );
}

/**
 * Choosing a repository.
 *
 * The list is one page of what the token can see, most recently pushed first —
 * which is the right hundred for a person, and nowhere near all of them for an
 * organisation. So the field doubles as a lookup: type a full "owner/name" and
 * it is fetched by name, whether or not it was on the list.
 */
function Picker({
  linked,
  login,
  hint,
  stale,
  onPick,
  onDone,
}: {
  linked: Set<string>;
  login: string;
  hint: string;
  stale: boolean;
  onPick: (repo: Listed) => void;
  onDone: () => void;
}) {
  const available = useAction(api.github.repos.available);
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
    available({})
      .then((rows) => alive && setList(rows))
      .catch((error) => alive && setFailure(reason(error)))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [available]);

  const typed = filter.trim();
  const shown = (list ?? []).filter(
    (repo) => !linked.has(repo.fullName) && repo.fullName.toLowerCase().includes(typed.toLowerCase()),
  );
  // Worth offering the moment it is a plausible name — an org repo the page of
  // recents did not reach looks exactly like a typo until you ask GitHub.
  const nameable = /^[\w.-]+\/[\w.-]+$/.test(typed) && !shown.some((r) => r.fullName === typed);

  const byName = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const repo = await lookup({ fullName: typed });
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
          placeholder="Filter, or type owner/name"
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
        {busy && !list && <p className="nt-picker-empty">Reading your repositories…</p>}
        {list && !shown.length && !nameable && (
          <p className="nt-picker-empty">
            {typed
              ? "Nothing matches. Type the full owner/name to fetch it directly."
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
        <span className="min-w-0 flex-1 truncate">
          {stale ? "Token rejected — " : ""}@{login} · ····{hint}
        </span>
        <button
          type="button"
          onClick={() => void disconnect({})}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

/**
 * Connecting GitHub, which is one paste.
 *
 * A token rather than an App: an App has to be installed by whoever owns the
 * organisation, and a token you already have the right to create. The two kinds
 * fail in different ways in an org — a classic one needs authorising for SSO
 * after it is made, a fine-grained one needs the org to permit them at all — so
 * both are named here, and the error that comes back from `connect` says which
 * of those went wrong rather than "403".
 */
function Connect() {
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
    // Its own form, submitted by its own button: nested inside the new-project
    // dialog's form, an Enter here would otherwise create the project.
    <div className="nt-picker p-2.5">
      <p className="nt-note">
        Paste a GitHub personal access token. A classic token needs the{" "}
        <code className="nt-mono-inline">repo</code> scope, and “Configure SSO”
        on it to reach an organisation; a fine-grained one needs Contents: Read
        on the repositories you want.
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
          className="nt-row nt-solid shrink-0 px-3 font-medium"
        >
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
      {failure && (
        <p role="alert" className="mt-2 text-[13px] leading-snug text-danger">
          {failure}
        </p>
      )}
      <p className="nt-note mt-2">
        It is stored encrypted and never sent to the browser again.{" "}
        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Make one on GitHub
        </a>
      </p>
    </div>
  );
}
