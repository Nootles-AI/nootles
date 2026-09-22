"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { Listed } from "@/convex/github/repos";

export type NewProject = {
  title: string;
  description: string;
  context: string;
  /** Repositories to index into the project's context once it exists. */
  repos: Listed[];
  /** An `app/lib/templates` id; absent means blank. */
  template?: string;
};

/**
 * What a project is, asked before it exists.
 *
 * None of this is filing: everything typed here becomes the project's Context
 * Sheet, which is what primes every request the agent makes inside it. So the
 * fields are asked in the order they are worth — the title, the sentence, then
 * the room to say the things that have nowhere else to go.
 *
 * Only the title is required. A project with a title and nothing else is a
 * perfectly good project, and asking for more before letting someone start
 * would be a form standing between them and a blank page.
 */
export function useNewProjectDraft(
  /** Resolves `false` when nothing was made yet — the plan's wall stepped in —
   *  and the form is handed back as it was, to send again. */
  onCreate: (project: NewProject) => Promise<boolean | void>,
  template?: string,
) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState("");
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
      template,
    })
      .then((made) => {
        if (made === false) setBusy(false);
      })
      .catch(() => {
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

  return {
    title, setTitle, description, setDescription, context, setContext,
    repos, setRepos, busy, failure, named, submit, sendOnModEnter,
  };
}
