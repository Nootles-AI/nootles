"use client";

import { useEffect, useState, type AnimationEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ABOUT, BACKGROUND } from "@/convex/ai/questions";
import type { Listed } from "@/convex/github/repos";
import { reason } from "@/app/lib/github";
import { X } from "../Icons";
import { GitHubRepos, type Chosen } from "./GitHubRepos";

/**
 * What the assistant knows about this project, after it exists.
 *
 * The new-project dialog asks the same two questions and then never asks again,
 * which left the Context Sheet write-once: everything typed at creation primed
 * every request forever and could not be corrected. This is the other half of
 * that form — the same two fields, the entries anything else has added since,
 * and the repositories, which are the one kind of context that is read rather
 * than written.
 */
export function ContextDialog({
  projectId,
  onClose,
}: {
  projectId: Id<"projects">;
  onClose: () => void;
}) {
  const entries = useQuery(api.ai.context.list, { projectId });
  const repos = useQuery(api.github.repos.listForProject, { projectId });
  const add = useMutation(api.ai.context.add);
  const answer = useMutation(api.ai.context.answer);
  const remove = useMutation(api.ai.context.remove);
  const link = useMutation(api.github.repos.link);
  const unlink = useMutation(api.github.repos.unlink);
  const refresh = useAction(api.github.repos.refresh);

  const [failure, setFailure] = useState<string | null>(null);

  // Leaving is animated, so it outlives the decision to leave — the same
  // contract as the new-project dialog, and for the same reason.
  const [closing, setClosing] = useState(false);
  const gone = (e: AnimationEvent<HTMLElement>) => {
    if (closing && e.target === e.currentTarget) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setClosing(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Write an answer to one of the standing questions, creating its row the
   * first time. A project made with only a title has no entries at all, and
   * asking someone to "add a note" before they can say what the project is
   * would be a worse form than the one they filled in to make it.
   */
  const say = (question: string, said: string) => {
    // Until the sheet has loaded there is no way to tell a new answer from an
    // edit to an existing one, and guessing wrong writes a second row saying
    // the same thing in the same words.
    if (!entries) return;
    const existing = entries.find((e) => e.question === question);
    const value = said.trim();
    if (existing) {
      if ((existing.answer ?? "") === value) return;
      if (value) void answer({ id: existing._id, answer: value });
      else void remove({ id: existing._id });
    } else if (value) {
      void add({ projectId, question, answer: value, source: "human" });
    }
  };

  const standing = new Set([ABOUT, BACKGROUND]);
  const also = entries?.filter((e) => !standing.has(e.question)) ?? [];

  const chosen: Chosen[] = (repos ?? []).map((repo) => ({
    key: repo._id,
    fullName: repo.fullName,
    description: repo.description,
    private: repo.private,
    ...note(repo),
  }));

  return (
    <>
      <button
        aria-label="Close"
        onClick={() => setClosing(true)}
        className={`nt-scrim${closing ? " is-closing" : ""}`}
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <div
        onAnimationEnd={gone}
        role="dialog"
        aria-modal="true"
        aria-label="Project context"
        className={`nt-dialog${closing ? " is-closing" : ""}`}
        style={{ zIndex: "var(--z-modal)" }}
      >
        <div className="nt-dialog-head">
          <p className="text-sm font-medium">Project context</p>
          <p className="mt-1.5 text-[13px] text-muted">
            What the assistant is told before every request in this project.
            Changes take effect on the next message.
          </p>
        </div>

        <div className="nt-dialog-body">
          <div>
            <Field
              id="ctx-about"
              label="Description"
              question={ABOUT}
              value={entries?.find((e) => e.question === ABOUT)?.answer ?? ""}
              placeholder="One line on what it is"
              onCommit={say}
            />
            <Field
              id="ctx-background"
              label="Context"
              question={BACKGROUND}
              value={entries?.find((e) => e.question === BACKGROUND)?.answer ?? ""}
              placeholder="Who it is for, what has been decided, anything to take as given"
              multiline
              onCommit={say}
            />

            {also.length > 0 && (
              <div className="mt-4">
                <div className="nt-field-label">
                  Also noted
                  <span className="nt-field-note">{also.length}</span>
                </div>
                <ul className="space-y-2">
                  {also.map((entry) => (
                    <li key={entry._id} className="nt-repo items-start">
                      <span className="nt-repo-body">
                        <span className="nt-repo-note">{entry.question}</span>
                        <span className="block text-[13px] leading-snug">
                          {entry.answer || "—"}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void remove({ id: entry._id })}
                        aria-label={`Remove “${entry.question}”`}
                        title="Remove"
                        className="nt-icon-btn is-sm"
                      >
                        <X />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div>
            <GitHubRepos
              repos={chosen}
              onAdd={(repo: Listed) => {
                setFailure(null);
                void link({ projectId, repos: [strip(repo)] }).catch((error) =>
                  setFailure(reason(error, "That repository could not be linked.")),
                );
              }}
              onRemove={(key) => void unlink({ repoId: key as Id<"projectRepos"> })}
            />
            {chosen.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setFailure(null);
                  // Sequential rather than concurrent: each one is three
                  // requests to GitHub, and a rate limit spent on a refresh
                  // nobody asked for is a bad trade.
                  void (async () => {
                    for (const repo of repos ?? []) {
                      await refresh({ repoId: repo._id }).catch((error) =>
                        setFailure(reason(error)),
                      );
                    }
                  })();
                }}
                className="nt-row mt-1 w-full text-muted"
              >
                <span className="nt-row-label">Re-read all repositories</span>
              </button>
            )}
          </div>
        </div>

        <div className="nt-dialog-foot">
          {failure && (
            <p role="alert" className="min-w-0 flex-1 text-[13px] text-danger">
              {failure}
            </p>
          )}
          <button
            type="button"
            onClick={() => setClosing(true)}
            className="nt-row nt-solid px-3 font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * A standing question, drawn as the field it was originally asked as.
 *
 * Held locally while it is being typed and written on blur, the way the rest of
 * the app treats a name being edited — a mutation per keystroke would be a
 * write per keystroke, and this is the one form where what you type IS what the
 * model reads.
 */
function Field({
  id,
  label,
  question,
  value,
  placeholder,
  multiline,
  onCommit,
}: {
  id: string;
  label: string;
  question: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  onCommit: (question: string, said: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const props = {
    id,
    value: shown,
    placeholder,
    className: "nt-input",
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      onCommit(question, shown);
      setDraft(null);
    },
  };

  return (
    <>
      <label className="nt-field-label mt-4 first:mt-0" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea {...props} rows={5} spellCheck />
      ) : (
        <input {...props} autoComplete="off" />
      )}
    </>
  );
}

/**
 * The second line of a repository row: what the last read of it found. Nothing
 * when it went fine — the description is a better line than "read 4 minutes
 * ago", and `GitHubRepos` falls back to it.
 */
function note(repo: { syncError?: string; syncedAt?: number }): {
  note?: string;
  noteIsProblem?: boolean;
} {
  if (repo.syncError) return { note: repo.syncError, noteIsProblem: true };
  if (!repo.syncedAt) return { note: "Reading…" };
  return {};
}

/** The picker hands back more than a link needs; the extra would fail validation. */
function strip(repo: Listed) {
  return {
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    ...(repo.description ? { description: repo.description } : {}),
    private: repo.private,
  };
}
