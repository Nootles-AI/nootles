"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { normalizeSlug, slugProblem, typingSlug } from "@/convex/slugs";
import { homePath } from "@/app/lib/containerPaths";
import { Dialog } from "../Dialog";
import "./workspaces.css";

/** How long typing rests before the server is asked whether an address is free. */
const SETTLE_MS = 250;

/**
 * Making a workspace: a name, and the address it will answer to.
 *
 * The address follows the name until someone edits it, and is shown as it
 * will be kept — the same rules as the server's (`convex/slugs.ts`), so
 * nothing is said here that `create` would contradict. Whether it is already
 * taken is the server's to know; it is asked once typing rests, and the answer
 * is only shown while it is still about what the field holds.
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
  const create = useMutation(api.workspaces.create);
  const [name, setName] = useState("");
  // Null while the address follows the name.
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const slug = normalizeSlug(typed ?? name);
  const named = name.trim();
  const local = named || typed ? slugProblem(slug) : null;
  const settled = useSettled(slug);
  const check = useQuery(
    api.workspaces.checkSlug,
    !local && settled === slug ? { slug } : "skip",
  );
  const problem = local ?? (check?.slug === slug ? check.problem : null);
  const ready = !!named && !problem && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    try {
      const made = await create({ name: named, slug });
      // Left busy: the workspace's home replaces this screen, dialog and all.
      router.push(homePath(made.slug));
    } catch (error) {
      setBusy(false);
      setFailure(
        error instanceof ConvexError && typeof error.data === "string"
          ? error.data
          : "Couldn’t make that workspace. Try again in a moment.",
      );
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
                {problem ?? "Where your team finds it. You can change it later; old links keep working."}
              </p>
            </div>
          </div>
        </div>

        <div className="nt-pal-foot">
          {failure ? (
            <span role="alert" className="text-danger">
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

/** `value`, once it has stopped changing for a moment. */
function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}
