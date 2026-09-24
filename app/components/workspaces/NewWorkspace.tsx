"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { normalizeSlug, typingSlug } from "@/convex/slugs";
import { homePath } from "@/app/lib/containerPaths";
import { rememberScreen, rememberWorkspace } from "@/app/lib/projectsCache";
import { Dialog } from "../Dialog";
import { refusal } from "./refusal";
import { useSlugProblem } from "./useSlugProblem";
import "./workspaces.css";

/**
 * Making a workspace: a name, and the address it will answer to.
 *
 * The address follows the name until someone edits it, and is shown as it
 * will be kept, judged as it is typed (`useSlugProblem`).
 */
export function NewWorkspace({ onClose }: { onClose: () => void }) {
  return (
    <Dialog label="New workspace" className="nt-palette is-solo nt-ws-new" onClose={onClose}>
      {(close) => <Form onCancel={close} />}
    </Dialog>
  );
}

function Form({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const { userId } = useAuth();
  const create = useMutation(api.workspaces.create);
  const [name, setName] = useState("");
  // Null while the address follows the name.
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const slug = normalizeSlug(typed ?? name);
  const named = name.trim();
  // Until the server has said the address is free, it is not yet something to make.
  const { problem, pending } = useSlugProblem(slug, { judge: !!(named || typed) });
  const ready = !!named && !problem && !pending && !busy;
  const note =
    problem ?? "Where your team finds it. Links to the old address keep working if you change it later.";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    try {
      const made = await create({ name: named, slug });
      // All of it already known — whose it is, what it is called, that it is
      // empty — so its home is told before it opens, and draws at once.
      if (userId) {
        rememberWorkspace(userId, made.slug, {
          kind: "workspace",
          workspaceId: made.workspaceId,
          slug: made.slug,
          name: named,
          role: "owner",
        });
        rememberScreen(userId, made.workspaceId, [], []);
      }
      // Left busy: the workspace's home replaces this screen, dialog and all.
      router.push(homePath(made.slug));
    } catch (error) {
      setBusy(false);
      setFailure(refusal(error, "Couldn’t make that workspace. Try again in a moment."));
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="nt-pal-field">
        <span className="nt-pal-crumb">New workspace</span>
        <span className="flex-1" />
        <kbd className="nt-kbd">esc</kbd>
      </div>
      <form className="nt-pal-form" onSubmit={submit}>
        <label className="nt-pal-name-row">
          <span className="sr-only">Name</span>
          <input
            autoFocus
            id="nt-ws-new-name"
            autoComplete="off"
            className="nt-pal-name-input"
            placeholder="Workspace name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setFailure(null);
            }}
          />
        </label>

        <div className="nt-pal-fields">
          <div className="nt-pal-fld">
            <label htmlFor="nt-ws-new-slug" className="nt-pal-key">
              Address
            </label>
            <div className="min-w-0">
              <div className="nt-ws-address">
                <span className="nt-ws-address-base" aria-hidden="true">
                  {window.location.host}/w/
                </span>
                <input
                  id="nt-ws-new-slug"
                  autoComplete="off"
                  spellCheck={false}
                  className="nt-pal-input"
                  placeholder="your-team"
                  value={typed ?? slug}
                  aria-invalid={!!problem}
                  aria-describedby="nt-ws-new-slug-note"
                  onChange={(e) => {
                    setTyped(typingSlug(e.target.value));
                    setFailure(null);
                  }}
                  // Emptied, it goes back to following the name.
                  onBlur={() => setTyped((t) => (t && normalizeSlug(t)) || null)}
                />
              </div>
              <p
                id="nt-ws-new-slug-note"
                aria-live="polite"
                className={`nt-ws-note${problem ? " is-problem" : ""}`}
              >
                {/* A new sentence settles in; the line keeps its place. */}
                <span key={note} className="block nt-settle">
                  {note}
                </span>
              </p>
            </div>
          </div>
        </div>

        <div className="nt-pal-foot">
          {failure ? (
            <span key={failure} role="alert" className="nt-settle text-danger">
              {failure}
            </span>
          ) : (
            <span className="nt-ws-hint">
              <kbd className="nt-kbd">↵</kbd>
              Create workspace
            </span>
          )}
          <span className="ml-auto flex gap-1">
            <button type="button" onClick={onCancel} className="nt-row px-2.5">
              Cancel
            </button>
            <button type="submit" disabled={!ready} className="nt-row nt-solid px-3 font-medium">
              {busy ? "Creating…" : "Create"}
            </button>
          </span>
        </div>
      </form>
    </div>
  );
}
