"use client";

import { useState, type FormEvent } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { ContextFileError } from "@/app/lib/contextFiles";
import type { DraftSourcesValue } from "./context/ContextSources";

/**
 * The workspace a new project is made in, and who in it sees the project.
 * Plain JSON, like the rest of the draft: it rides the paywall's round trip.
 */
export type ProjectHome = {
  workspaceId: Id<"workspaces">;
  /** Where it opens once made; an address retired meanwhile still arrives. */
  slug: string;
  visibility: "workspace" | "private";
};

export type NewProject = {
  title: string;
  description: string;
  /** Files, repositories and Notion pages to read into its context once it exists. */
  sources: DraftSourcesValue;
  /** An `app/lib/templates` id; absent means blank. */
  template?: string;
  /** Absent means the person's own projects. */
  workspace?: ProjectHome;
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
  /** Where it goes unless they choose otherwise: the home it was started from. */
  home?: ProjectHome,
) {
  const [title, setTitle] = useState("");
  const [workspace, setWorkspace] = useState(home);
  const [description, setDescription] = useState("");
  const [sources, setSources] = useState<DraftSourcesValue>({ repos: [], files: [], pages: [] });
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
      sources,
      template,
      ...(workspace ? { workspace } : {}),
    })
      .then((made) => {
        if (made === false) setBusy(false);
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ContextFileError ? error.message : "Couldn’t create that project.",
        );
        setBusy(false);
      });
  };

  return {
    title, setTitle, description, setDescription, sources, setSources,
    workspace, setWorkspace, busy, failure, named, submit,
  };
}
