"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ArrowLeft, MoreHorizontal, Plus } from "@/app/components/Icons";
import { Editable } from "@/app/components/Editable";
import { Menu, MenuItem } from "@/app/components/Menu";

/** "2d ago" / "Jul 12" — coarse enough that it never needs to re-render. */
function when(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ProjectsScreen() {
  const router = useRouter();
  const projects = useQuery(api.projects.listWithCounts);
  const createProject = useMutation(api.projects.create);
  const renameProject = useMutation(api.projects.rename);
  const removeProject = useMutation(api.projects.remove);

  const [editingId, setEditingId] = useState<Id<"projects"> | null>(null);
  const [confirmingId, setConfirmingId] = useState<Id<"projects"> | null>(null);
  const [draft, setDraft] = useState("");

  const open = (id: Id<"projects">) => router.push(`/?project=${id}`);

  const commitRename = (id: Id<"projects">) => {
    const title = draft.trim();
    if (title) renameProject({ projectId: id, title });
    setEditingId(null);
  };

  return (
    <main
      className="mx-auto w-full px-6 py-12 sm:px-8 sm:py-20"
      style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
    >
      <Link
        href="/"
        className="ab-row -ml-2 mb-6 inline-flex pr-3 text-muted"
      >
        <ArrowLeft width={14} height={14} />
        Back to workspace
      </Link>

      <div className="mb-1 flex items-end justify-between gap-4">
        <h1 className="text-[length:var(--text-title)] font-semibold tracking-[-0.02em]">
          Projects
        </h1>
        <button
          onClick={() =>
            createProject({ title: "Untitled project" }).then((id) => {
              setDraft("Untitled project");
              setEditingId(id);
            })
          }
          className="ab-row gap-1.5 bg-sunken px-3 font-medium"
        >
          <Plus width={14} height={14} />
          New project
        </button>
      </div>
      <p className="text-[13px] text-muted">
        Click a project to open it. Double-click the name to rename, or use
        the ⋯ menu.
      </p>

      {projects === undefined ? (
        // Same row height as the real list, so content swaps in without reflow.
        <ul className="mt-6" aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 py-0.5">
              <span
                className="ab-skeleton h-4 flex-1"
                style={{ maxWidth: `${[62, 44, 53][i]}%`, animationDelay: `${i * 120}ms` }}
              />
              <span className="ab-skeleton hidden h-3 w-20 sm:block" />
              <span className="ab-skeleton h-3 w-20" />
              <span className="w-8" />
            </li>
          ))}
        </ul>
      ) : projects.length === 0 ? (
        <div className="mt-10 rounded-lg bg-surface px-6 py-14 text-center">
          <p className="text-sm font-medium">No projects yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-muted">
            A project holds a set of pages. Create one to start writing, and it
            arrives with a blank page ready to go.
          </p>
        </div>
      ) : (
        <ul className="mt-6">
          {projects.map((p) => (
            <li
              key={p._id}
              className="group flex items-center gap-3 py-0.5"
            >
              {editingId === p._id ? (
                <Editable
                  autoFocus
                  value={draft}
                  label="Project name"
                  onInput={setDraft}
                  onBlur={() => commitRename(p._id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename(p._id);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  className="ab-row is-selected flex-1 truncate font-medium"
                />
              ) : (
                <>
                  <button
                    onClick={() => open(p._id)}
                    onDoubleClick={() => {
                      setDraft(p.title);
                      setEditingId(p._id);
                    }}
                    title="Double-click to rename"
                    className="ab-row flex-1 font-medium"
                  >
                    <span className="ab-row-label">
                      {p.title || "Untitled project"}
                    </span>
                  </button>
                  <span className="ab-meta hidden w-20 shrink-0 text-right sm:block">
                    {p.pageCount} {p.pageCount === 1 ? "page" : "pages"}
                  </span>
                  <span className="ab-meta w-20 shrink-0 text-right">
                    {when(p.updatedAt)}
                  </span>
                </>
              )}

              {confirmingId === p._id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => setConfirmingId(null)}
                    className="ab-row px-2.5"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      removeProject({ projectId: p._id });
                      setConfirmingId(null);
                    }}
                    className="ab-row px-2.5 font-medium text-danger"
                  >
                    Delete {p.pageCount} {p.pageCount === 1 ? "page" : "pages"}
                  </button>
                </span>
              ) : (
                <Menu
                  label={`Actions for ${p.title || "Untitled project"}`}
                  side="bottom"
                  align="end"
                  trigger={(t) => (
                    <button
                      {...t}
                      aria-label={`Actions for ${p.title || "Untitled project"}`}
                      className="ab-icon-btn opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                    >
                      <MoreHorizontal />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem onClick={() => open(p._id)}>Open</MenuItem>
                      <MenuItem
                        onClick={() => {
                          setDraft(p.title);
                          setEditingId(p._id);
                          close();
                        }}
                      >
                        Rename
                      </MenuItem>
                      <div className="ab-menu-sep" />
                      <MenuItem
                        danger
                        onClick={() => {
                          setConfirmingId(p._id);
                          close();
                        }}
                      >
                        Delete…
                      </MenuItem>
                    </>
                  )}
                </Menu>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
