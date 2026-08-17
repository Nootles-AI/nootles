"use client";

import { FormEvent, KeyboardEvent, useState } from "react";
import type { Listed } from "@/convex/github/repos";
import { Dialog } from "./Dialog";
import { GitHubRepos } from "./context/GitHubRepos";

export type NewProject = {
  title: string;
  description: string;
  context: string;
  repos: Listed[];
};

/**
 * What a project is, asked before it exists.
 *
 * None of this is filing: everything typed here becomes the project's Context
 * Sheet, which is what primes every request the agent makes inside it. So the
 * three fields are asked in the order they are worth — the title, the sentence,
 * then the room to say the things that have nowhere else to go.
 *
 * Only the title is required. A project with a title and nothing else is a
 * perfectly good project, and asking for more before letting someone start
 * would be a form standing between them and a blank page.
 */
export function NewProjectDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  /** Resolves once the project exists; the caller closes this and opens it. */
  onCreate: (project: NewProject) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState("");
  // Held here rather than written, because there is no project to write them to
  // yet: `projects.create` takes them and links them in the same transaction it
  // makes the project in.
  const [repos, setRepos] = useState<Listed[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const named = title.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!named || busy) return;
    setBusy(true);
    setFailure(null);
    // Left busy on the way out: the caller opens the project next, and a button
    // that comes back to life during the navigation invites a second project.
    onCreate({
      title: named,
      description: description.trim(),
      context: context.trim(),
      repos,
    }).catch(() => {
      setFailure("Couldn’t create that project.");
      setBusy(false);
    });
  };

  /** Enter sends a one-line field; a box you can write paragraphs in needs the modifier. */
  const sendOnModEnter = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  };

  return (
    <Dialog
      label="New project"
      scrimLabel="Cancel"
      as="form"
      onSubmit={submit}
      onClose={onCancel}
    >
      {(close) => (
        <>
          <div className="nt-dialog-head">
            <p className="text-sm font-medium">New project</p>
            <p className="mt-1.5 text-[13px] text-muted">
              Whatever you say here is what the assistant knows about the
              project. You can change it later.
            </p>
          </div>

          <div className="nt-dialog-body">
            <div>
              <label className="nt-field-label" htmlFor="np-title">
                Title
              </label>
              <input
                id="np-title"
                autoFocus
                autoComplete="off"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Project title"
                className="nt-input"
              />

              <label className="nt-field-label mt-4" htmlFor="np-description">
                Description
                <span className="nt-field-note">Optional</span>
              </label>
              <input
                id="np-description"
                autoComplete="off"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One line on what it is"
                className="nt-input"
              />

              <div className="mt-4">
                <GitHubRepos
                  repos={repos.map((repo) => ({
                    key: repo.fullName,
                    fullName: repo.fullName,
                    description: repo.description,
                    private: repo.private,
                  }))}
                  onAdd={(repo) => setRepos((chosen) => [...chosen, repo])}
                  onRemove={(key) =>
                    setRepos((chosen) =>
                      chosen.filter((r) => r.fullName !== key),
                    )
                  }
                />
              </div>
            </div>

            <div className="nt-field-fill">
              <label className="nt-field-label" htmlFor="np-context">
                Context
                <span className="nt-field-note">Optional</span>
              </label>
              <textarea
                id="np-context"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                onKeyDown={sendOnModEnter}
                placeholder="Who it is for, what has been decided, anything the assistant should take as given"
                className="nt-input"
              />
            </div>
          </div>

          <div className="nt-dialog-foot">
            {failure && (
              <p
                role="alert"
                className="min-w-0 flex-1 text-[13px] text-danger"
              >
                {failure}
              </p>
            )}
            <button type="button" onClick={close} className="nt-row px-2.5">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!named || busy}
              className="nt-row nt-solid px-3 font-medium"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
