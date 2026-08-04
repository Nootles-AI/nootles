"use client";

import { FormEvent, KeyboardEvent, useEffect, useState } from "react";

export type NewProject = { title: string; description: string; context: string };

/**
 * What a project is, asked before it exists.
 *
 * None of this is filing: everything typed here becomes the project's Context
 * Sheet, which is what primes every request the agent makes inside it. So the
 * three fields are asked in the order they are worth — the name, the sentence,
 * then the room to say the things that have nowhere else to go.
 *
 * Only the name is required. A project with a name and nothing else is a
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
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
    <>
      <button
        aria-label="Cancel"
        onClick={onCancel}
        className="fixed inset-0 bg-foreground/15"
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        className="nt-menu fixed left-1/2 top-[14vh] w-[26rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5"
        style={{ zIndex: "var(--z-modal)" }}
      >
        <p className="text-sm font-medium">New project</p>
        <p className="mt-1.5 text-[13px] text-muted">
          Whatever you say here is what the assistant knows about the project. You
          can change it later.
        </p>

        <div className="mt-5">
          <label className="nt-field-label" htmlFor="np-title">
            Name
          </label>
          <input
            id="np-title"
            autoFocus
            autoComplete="off"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Rate limiting at the edge"
            className="nt-input"
          />
        </div>

        <div className="mt-4">
          <label className="nt-field-label" htmlFor="np-description">
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
        </div>

        <div className="mt-4">
          <label className="nt-field-label" htmlFor="np-context">
            Context
            <span className="nt-field-note">Optional</span>
          </label>
          <textarea
            id="np-context"
            rows={4}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            onKeyDown={sendOnModEnter}
            placeholder="Who it is for, what has been decided, anything the assistant should take as given"
            className="nt-input"
          />
        </div>

        {failure && (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {failure}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-1">
          <button type="button" onClick={onCancel} className="nt-row px-2.5">
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
      </form>
    </>
  );
}
