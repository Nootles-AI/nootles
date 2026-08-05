"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { track } from "@/app/lib/telemetry";
import { GridView, ListView, MoreHorizontal, Plus } from "./Icons";
import { AccountMenu } from "./AccountMenu";
import { Brandmark } from "./Brand";
import { ConfirmDeleteDialog } from "./ConfirmDelete";
import { ContextMenu } from "./ContextMenu";
import { Editable } from "./Editable";
import { Menu, MenuItem } from "./Menu";
import { NewProjectDialog, type NewProject } from "./NewProjectDialog";
import { PagePreview } from "./PagePreview";
import { useHints } from "./hints/useHints";

type View = "grid" | "list";
type Project = NonNullable<
  ReturnType<typeof useQuery<typeof api.projects.listForScreen>>
>[number];

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

const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

export function ProjectsScreen() {
  const router = useRouter();
  const projects = useQuery(api.projects.listForScreen);
  const createProject = useMutation(api.projects.create);
  const renameProject = useMutation(api.projects.rename);
  const removeProject = useMutation(api.projects.remove);

  // Being here IS the structure lesson the sidebar hint teaches, so arriving
  // retires it.
  const hints = useHints();
  useEffect(() => {
    if (hints.alive("sidebar")) hints.die("sidebar");
  }, [hints]);

  const [view, setView] = useState<View>("grid");
  const [editingId, setEditingId] = useState<Id<"projects"> | null>(null);
  const [confirming, setConfirming] = useState<Project | null>(null);
  const [ctx, setCtx] = useState<{ project: Project; x: number; y: number } | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [naming, setNaming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Restore the persisted view on the client. The default renders first so SSR
  // and the first client render agree; set-state-in-effect is correct here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (localStorage.getItem("nt:projectsView") === "list") setView("list");
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    localStorage.setItem("nt:projectsView", view);
  }, [view]);

  const open = (id: Id<"projects">) => router.push(`/p/${id}`);

  const startRename = (p: Project) => {
    setDraft(p.title);
    setEditingId(p._id);
  };

  /**
   * An empty name is not a rename, and silently restoring the old one looks
   * like the keystroke was lost. It says so instead, and keeps the field open.
   */
  const commitRename = (id: Id<"projects">) => {
    const title = draft.trim();
    if (!title) {
      setFailure("A project needs a name.");
      return;
    }
    setEditingId(null);
    renameProject({ projectId: id, title }).catch(() =>
      setFailure("That rename didn’t save."),
    );
  };

  /**
   * A project is made from what the dialog collected and then opened, rather
   * than appearing on this screen as another card to find and click. It already
   * has a name, and its first page is the only place there is to go.
   */
  const create = async (project: NewProject) => {
    const id = await createProject({
      title: project.title,
      ...(project.description ? { description: project.description } : {}),
      ...(project.context ? { context: project.context } : {}),
    });
    track("project_created", {});
    router.push(`/p/${id}`);
  };

  const confirmRemove = () => {
    if (!confirming) return;
    const doomed = confirming;
    setConfirming(null);
    removeProject({ projectId: doomed._id }).catch(() =>
      setFailure(`Couldn’t delete “${doomed.title || "Untitled project"}”.`),
    );
  };

  return (
    <main
      className="mx-auto w-full px-6 py-12 sm:px-8 sm:py-16"
      style={{ maxWidth: "76rem" }}
    >
      {/* The mark sits with the title rather than in a bar of its own: this is
          the app's front door, and it is the one screen in the product with a
          corner free to say whose software this is. Inside a project the
          sidebar already spends that corner on the way back out. */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Brandmark
            role="img"
            aria-label="Nootles"
            width={20}
            height={24}
            className="text-brand"
          />
          <h1 className="text-[length:var(--text-title)] font-semibold tracking-[-0.02em]">
            Projects
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <div className="nt-mode" role="group" aria-label="View">
            <button
              onClick={() => setView("grid")}
              aria-pressed={view === "grid"}
              aria-label="Grid view"
              className={`nt-mode-btn is-icon${view === "grid" ? " is-on" : ""}`}
            >
              <GridView width={14} height={14} />
            </button>
            <button
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              aria-label="List view"
              className={`nt-mode-btn is-icon${view === "list" ? " is-on" : ""}`}
            >
              <ListView width={14} height={14} />
            </button>
          </div>

          <button
            onClick={() => setNaming(true)}
            className="nt-row gap-1.5 bg-sunken px-3 font-medium"
          >
            <Plus width={14} height={14} />
            New project
          </button>
          <AccountMenu />
        </div>
      </header>

      {/* One place for anything that failed, rather than a mutation failing in
          silence. It clears on the next successful action. */}
      {failure && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {failure}
        </p>
      )}

      <div className="mt-8">
        {projects === undefined ? (
          <Skeletons view={view} />
        ) : projects.length === 0 ? (
          <Empty onCreate={() => setNaming(true)} />
        ) : view === "grid" ? (
          <ul className="nt-grid">
            {projects.map((p) => (
              <li
                key={p._id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({ project: p, x: e.clientX, y: e.clientY });
                }}
              >
                <Card
                  project={p}
                  editing={editingId === p._id}
                  draft={draft}
                  onDraft={setDraft}
                  onOpen={() => open(p._id)}
                  onRename={() => startRename(p)}
                  onCommit={() => commitRename(p._id)}
                  onCancel={() => setEditingId(null)}
                  onDelete={() => setConfirming(p)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <div>
            <div className="nt-list-head" aria-hidden="true">
              <span className="flex-1">Name</span>
              <span className="nt-col-pages">Pages</span>
              <span className="nt-col-when">Edited</span>
              <span className="nt-col-actions" />
            </div>
            <ul className="mt-1">
              {projects.map((p) => (
                <li
                  key={p._id}
                  className="nt-list-row group"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtx({ project: p, x: e.clientX, y: e.clientY });
                  }}
                >
                  <Row
                    project={p}
                    editing={editingId === p._id}
                    draft={draft}
                    onDraft={setDraft}
                    onOpen={() => open(p._id)}
                    onRename={() => startRename(p)}
                    onCommit={() => commitRename(p._id)}
                    onCancel={() => setEditingId(null)}
                    onDelete={() => setConfirming(p)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          label={`Actions for ${ctx.project.title || "Untitled project"}`}
          onClose={() => setCtx(null)}
        >
          <ProjectActions
            close={() => setCtx(null)}
            onOpen={() => open(ctx.project._id)}
            onRename={() => startRename(ctx.project)}
            onDelete={() => setConfirming(ctx.project)}
          />
        </ContextMenu>
      )}

      {naming && (
        <NewProjectDialog onCancel={() => setNaming(false)} onCreate={create} />
      )}

      {confirming && (
        <ConfirmDeleteDialog
          title={confirming.title || "Untitled project"}
          what={`“${confirming.title || "Untitled project"}” and its ${pages(
            confirming.pageCount,
          )}`}
          onCancel={() => setConfirming(null)}
          onConfirm={confirmRemove}
        />
      )}
    </main>
  );
}

/** The actions every view offers, so the two never drift apart. */
function RowMenu({
  project,
  onOpen,
  onRename,
  onDelete,
  className,
}: {
  project: Project;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  className?: string;
}) {
  const name = project.title || "Untitled project";
  return (
    <Menu
      label={`Actions for ${name}`}
      side="bottom"
      align="end"
      trigger={(t) => (
        <button
          {...t}
          aria-label={`Actions for ${name}`}
          className={`nt-icon-btn ${className ?? ""}`}
        >
          <MoreHorizontal />
        </button>
      )}
    >
      {(close) => (
        <ProjectActions
          close={close}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
        />
      )}
    </Menu>
  );
}

/**
 * The three things you can do to a project, written once so the ⋯ menu and the
 * right-click menu cannot drift apart.
 *
 * Rename and delete both close with `restoreFocus: false`, because both hand
 * focus to something of their own — the rename field, the confirm dialog — and
 * a menu that insists on taking focus back afterwards undoes them.
 */
function ProjectActions({
  close,
  onOpen,
  onRename,
  onDelete,
}: {
  close: (opts?: { restoreFocus?: boolean }) => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <MenuItem
        onClick={() => {
          onOpen();
          close();
        }}
      >
        Open
      </MenuItem>
      <MenuItem
        onClick={() => {
          onRename();
          close({ restoreFocus: false });
        }}
      >
        Rename
      </MenuItem>
      <div className="nt-menu-sep" />
      <MenuItem
        danger
        onClick={() => {
          onDelete();
          close({ restoreFocus: false });
        }}
      >
        Delete…
      </MenuItem>
    </>
  );
}

/** The rename field, identical in both views so the interaction is one thing. */
function NameField({
  draft,
  onDraft,
  onCommit,
  onCancel,
  className,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  className: string;
}) {
  return (
    <Editable
      autoFocus
      value={draft}
      label="Project name"
      onInput={onDraft}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className={className}
    />
  );
}

function Card({
  project,
  editing,
  draft,
  onDraft,
  onOpen,
  onRename,
  onCommit,
  onCancel,
  onDelete,
}: {
  project: Project;
  editing: boolean;
  draft: string;
  onDraft: (v: string) => void;
  onOpen: () => void;
  onRename: () => void;
  onCommit: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const name = project.title || "Untitled project";
  return (
    <div className="nt-card group">
      {/* The thumbnail is the target; the footer is chrome. Nesting the menu
          inside this button would be a button inside a button. */}
      <button onClick={onOpen} aria-label={`Open ${name}`} className="nt-card-open">
        <PagePreview docId={project.firstPageDocId} />
      </button>

      <div className="nt-card-foot">
        <div className="min-w-0 flex-1">
          {editing ? (
            <NameField
              draft={draft}
              onDraft={onDraft}
              onCommit={onCommit}
              onCancel={onCancel}
              className="nt-card-name block w-full"
            />
          ) : (
            <p className="nt-card-name">{name}</p>
          )}
          <p className="nt-card-meta">
            <span>{pages(project.pageCount)}</span>
            <span aria-hidden="true">·</span>
            <span>{when(project.updatedAt)}</span>
          </p>
        </div>
        <RowMenu
          project={project}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
          className="is-sm"
        />
      </div>
    </div>
  );
}

function Row({
  project,
  editing,
  draft,
  onDraft,
  onOpen,
  onRename,
  onCommit,
  onCancel,
  onDelete,
}: {
  project: Project;
  editing: boolean;
  draft: string;
  onDraft: (v: string) => void;
  onOpen: () => void;
  onRename: () => void;
  onCommit: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const name = project.title || "Untitled project";
  return (
    <>
      {editing ? (
        <NameField
          draft={draft}
          onDraft={onDraft}
          onCommit={onCommit}
          onCancel={onCancel}
          className="nt-row-edit is-selected min-w-0 flex-1 font-medium"
        />
      ) : (
        <button onClick={onOpen} className="nt-row min-w-0 flex-1 font-medium">
          <span className="nt-row-label">{name}</span>
        </button>
      )}
      {/* Held in the layout while renaming rather than unmounted, so the row
          does not change shape as the field opens. */}
      <span className="nt-meta nt-col-pages" aria-hidden={editing}>
        {editing ? "" : project.pageCount}
      </span>
      <span className="nt-meta nt-col-when" aria-hidden={editing}>
        {editing ? "" : when(project.updatedAt)}
      </span>
      <span className="nt-col-actions">
        <RowMenu
          project={project}
          onOpen={onOpen}
          onRename={onRename}
          onDelete={onDelete}
          className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
        />
      </span>
    </>
  );
}

/**
 * Loading takes the shape of the view it is loading into, so content swaps in
 * without the page rearranging under the cursor.
 */
function Skeletons({ view }: { view: View }) {
  if (view === "list") {
    return (
      <ul aria-busy="true" aria-label="Loading projects">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="nt-list-row">
            <span
              className="nt-skeleton ml-2 h-4 flex-1"
              style={{ maxWidth: `${[52, 38, 61, 45][i]}%`, animationDelay: `${i * 110}ms` }}
            />
            <span className="nt-skeleton nt-col-pages h-3" />
            <span className="nt-skeleton nt-col-when h-3" />
            <span className="nt-col-actions" />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="nt-grid" aria-busy="true" aria-label="Loading projects">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i}>
          <div className="nt-card">
            <span
              className="nt-skeleton block aspect-[4/3] rounded-none"
              style={{ animationDelay: `${i * 90}ms` }}
            />
            <div className="nt-card-foot">
              <span className="nt-skeleton h-3.5 flex-1" style={{ maxWidth: "60%" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Teaches what a project is, and offers the one action worth taking. */
function Empty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg bg-surface px-6 py-16 text-center">
      <p className="text-sm font-medium">No projects yet</p>
      <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-muted">
        A project holds a set of pages — prose, diagrams and maths in one place.
        The first one arrives with a blank page ready to go.
      </p>
      <button
        onClick={onCreate}
        className="nt-row mx-auto mt-5 gap-1.5 bg-background px-3 font-medium"
      >
        <Plus width={14} height={14} />
        New project
      </button>
    </div>
  );
}
