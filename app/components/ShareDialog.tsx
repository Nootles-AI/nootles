"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { track } from "@/app/lib/telemetry";
import { Dialog } from "./Dialog";
import { LinkIcon } from "./Icons";
import { Segmented, type Segment } from "./Segmented";

type LinkRole = "editor" | "viewer";

const TABS: readonly Segment<LinkRole>[] = [
  {
    id: "editor",
    label: "Editor link",
    hint: "Anyone with it can view; signing in lets them edit",
  },
  {
    id: "viewer",
    label: "Viewer link",
    hint: "Anyone with it can view. Nobody can edit through it",
  },
];

/**
 * Sharing, from the sidebar head: one link per role, each its own tab.
 *
 * The two links are deliberately separate capabilities rather than one link
 * with a setting — which URL you paste IS the decision, so handing someone
 * view access can never quietly become handing them the pen. Turning a link
 * off revokes it: the URL dies, and so does the access of everyone who signed
 * in through it.
 */
export function ShareDialog({ projectId }: { projectId: Id<"projects"> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label="Share project"
        aria-haspopup="dialog"
        title="Share"
        className="nt-icon-btn"
        onClick={() => setOpen(true)}
      >
        <LinkIcon />
      </button>
      {open && (
        <ShareDialogBody projectId={projectId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ShareDialogBody({
  projectId,
  onClose,
}: {
  projectId: Id<"projects">;
  onClose: () => void;
}) {
  const links = useQuery(api.share.links, { projectId });
  const collaborators = useQuery(api.share.collaborators, { projectId });
  const setLink = useMutation(api.share.setLink);

  const [role, setRole] = useState<LinkRole>("editor");
  const [copied, setCopied] = useState<LinkRole | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (token: string, which: LinkRole) => {
    await navigator.clipboard.writeText(
      `${window.location.origin}/share/${token}`,
    );
    setCopied(which);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
    track("share_link_copied", { role: which });
  };

  const token = links ? links[role] : null;

  return (
    <Dialog label="Share project" narrow onClose={onClose}>
      {(close) => (
        <>
          <div className="nt-dialog-head">
            <p className="text-sm font-medium">Share</p>
            <p className="mt-1.5 text-[13px] text-muted">
              Each link is its own door. Anyone can look through either; only
              people who sign in through the editor link can edit.
            </p>
          </div>

          <div className="nt-dialog-body">
            <div>
              <Segmented
                label="Link kind"
                segments={TABS}
                value={role}
                onChange={setRole}
              />

              {links === undefined ? null : token ? (
                <>
                  <div className="mt-3 flex items-center gap-1.5">
                    <input
                      readOnly
                      aria-label={`${role === "editor" ? "Editor" : "Viewer"} link`}
                      value={`${window.location.origin}/share/${token}`}
                      onFocus={(e) => e.currentTarget.select()}
                      className="nt-input min-w-0 flex-1"
                    />
                    <button
                      onClick={() => void copy(token, role)}
                      className="nt-row nt-solid shrink-0 px-3 font-medium"
                    >
                      {copied === role ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="nt-note mt-2">
                    {role === "editor"
                      ? "Anyone with this link can view; signing in lets them edit."
                      : "Anyone with this link can view. Nobody can edit through it."}
                  </p>
                  <button
                    onClick={() => {
                      void setLink({ projectId, role, enabled: false });
                      track("share_link_toggled", { role, on: false });
                    }}
                    className="nt-row mt-1 px-2.5 text-danger"
                  >
                    Turn off link
                  </button>
                </>
              ) : (
                <>
                  <p className="nt-note mt-3">
                    {role === "editor"
                      ? "Off. Nobody can view or edit through an editor link."
                      : "Off. Nobody can view through a viewer link."}
                  </p>
                  <button
                    onClick={() => {
                      void setLink({ projectId, role, enabled: true }).then(
                        (t) => {
                          if (t) void copy(t, role);
                        },
                      );
                      track("share_link_toggled", { role, on: true });
                    }}
                    className="nt-row nt-solid mt-2 px-3 font-medium"
                  >
                    Create {role} link
                  </button>
                </>
              )}

              {collaborators && collaborators.length > 0 && (
                <div className="mt-5">
                  <div className="nt-field-label">
                    People with access
                    <span className="nt-field-note">{collaborators.length}</span>
                  </div>
                  <ul className="space-y-px">
                    {collaborators.map((person) => (
                      <li
                        key={person.granteeId}
                        className="flex h-8 items-center gap-2 px-2"
                      >
                        {person.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={person.imageUrl}
                            alt=""
                            className="h-5 w-5 shrink-0 rounded-full"
                          />
                        ) : (
                          <span aria-hidden className="nt-monogram shrink-0">
                            {(person.name ?? person.email ?? "?")
                              .slice(0, 1)
                              .toUpperCase()}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {person.name ?? person.email ?? "Someone"}
                        </span>
                        <span className="shrink-0 text-[13px] text-muted">
                          {person.role === "editor" ? "Editor" : "Viewer"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          <div className="nt-dialog-foot">
            <button
              type="button"
              onClick={close}
              className="nt-row nt-solid px-3 font-medium"
            >
              Done
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
