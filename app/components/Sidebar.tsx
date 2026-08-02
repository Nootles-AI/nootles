"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ArrowLeft, PanelLeft, Plus } from "./Icons";
import { AccountMenu } from "./AccountMenu";
import { ConfirmDeleteDialog } from "./ConfirmDelete";
import { Editable } from "./Editable";
import { usePageChanges, type PageChange } from "./ReviewContext";

type Props = {
  width: number;
  projectId: Id<"projects">;
  selectedPageId: Id<"pages"> | null;
  onSelectPage: (id: Id<"pages">) => void;
  onCollapse: () => void;
};

export function Sidebar({
  width,
  projectId,
  selectedPageId,
  onSelectPage,
  onCollapse,
}: Props) {
  const project = useQuery(api.projects.get, { projectId });
  const pages = useQuery(api.pages.listByProject, { projectId });
  const changes = usePageChanges();
  const createPage = useMutation(api.pages.create);
  const renamePage = useMutation(api.pages.rename);
  const removePage = useMutation(api.pages.remove);
  const renameProject = useMutation(api.projects.rename);

  const [editing, setEditing] = useState<Id<"pages"> | "project" | null>(null);
  const [confirming, setConfirming] = useState<Id<"pages"> | null>(null);
  const [draft, setDraft] = useState("");
  /** Where a right-click opened the page menu, in viewport coordinates. */
  const [ctx, setCtx] = useState<{ id: Id<"pages">; x: number; y: number } | null>(
    null,
  );

  const sortedPages = pages?.slice().sort((a, b) => a.order - b.order);

  const commit = () => {
    const title = draft.trim();
    if (editing === "project") {
      if (title) renameProject({ projectId, title });
    } else if (editing) {
      // Empty is allowed: the row falls back to "Untitled".
      renamePage({ pageId: editing, title });
    }
    setEditing(null);
  };

  const startRename = (id: Id<"pages"> | "project", current: string) => {
    setDraft(current);
    setEditing(id);
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    }
  };

  return (
    <aside style={{ width }} className="ab-panel ab-rail-l" aria-label="Pages">
      {/* Back to the project list, the way a docs app returns to your files —
          there is no project switcher here because the route is the project. */}
      <div className="ab-panel-head">
        <Link href="/" className="ab-row min-w-0 flex-1 text-muted" title="All projects">
          <ArrowLeft width={14} height={14} className="shrink-0" />
          <span className="ab-row-label">Projects</span>
        </Link>
        <AccountMenu />
        <button
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="ab-icon-btn"
        >
          <PanelLeft />
        </button>
      </div>

      <div className="px-2 pb-2">
        {editing === "project" ? (
          <Editable
            autoFocus
            value={draft}
            label="Project name"
            onInput={setDraft}
            onBlur={commit}
            onKeyDown={keys}
            className="ab-row-edit ab-bare-focus w-full font-semibold"
          />
        ) : (
          <button
            onDoubleClick={() =>
              startRename("project", project?.title ?? "")
            }
            title="Double-click to rename"
            className="ab-row w-full font-semibold"
          >
            <span className="ab-row-label">
              {project?.title || "Untitled project"}
            </span>
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="ab-section-label">
          <span>Pages</span>
          <button
            onClick={() => createPage({ projectId }).then(onSelectPage)}
            aria-label="New page"
            title="New page"
            className="ab-icon-btn"
          >
            <Plus />
          </button>
        </div>

        <ul className="space-y-px">
          {sortedPages?.length === 0 && (
            <li className="px-2 py-1 text-[13px] text-muted">
              No pages yet — press + to add one.
            </li>
          )}
          {sortedPages?.map((pg) => (
            <li key={pg._id}>
              {editing === pg._id ? (
                <Editable
                  autoFocus
                  value={draft}
                  label="Page name"
                  onInput={setDraft}
                  onBlur={commit}
                  onKeyDown={keys}
                  className="ab-row-edit ab-bare-focus is-selected w-full"
                />
              ) : (
                <button
                  onClick={() => onSelectPage(pg._id)}
                  onDoubleClick={() => startRename(pg._id, pg.title)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtx({ id: pg._id, x: e.clientX, y: e.clientY });
                  }}
                  title="Double-click to rename · right-click for more"
                  aria-current={selectedPageId === pg._id ? "page" : undefined}
                  className={`ab-row w-full${
                    selectedPageId === pg._id ? " is-selected" : ""
                  }`}
                >
                  <span className="ab-row-label">{pg.title || "Untitled"}</span>
                  <ChangeCount change={changes.get(pg._id)} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {ctx && (
        <PageContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          onRename={() => {
            const pg = sortedPages?.find((p) => p._id === ctx.id);
            startRename(ctx.id, pg?.title ?? "");
            setCtx(null);
          }}
          onDelete={() => {
            setConfirming(ctx.id);
            setCtx(null);
          }}
        />
      )}

      {confirming && (
        <ConfirmDeleteDialog
          title={
            sortedPages?.find((p) => p._id === confirming)?.title || "Untitled"
          }
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            removePage({ pageId: confirming });
            setConfirming(null);
          }}
        />
      )}
    </aside>
  );
}

/**
 * What the agent has done to a page that nobody has answered yet.
 *
 * Counted in blocks rather than lines, because a block is what the review can
 * actually keep or discard. Sits beside the title rather than replacing it: it
 * is a reason to open the page, not the name of one.
 */
function ChangeCount({ change }: { change: PageChange | undefined }) {
  if (!change?.added && !change?.removed) return null;
  return (
    <span
      className="ab-row-diff"
      title={`${change.added} added, ${change.removed} removed, awaiting review`}
    >
      {change.added > 0 && <span className="ab-row-diff-add">+{change.added}</span>}
      {change.removed > 0 && <span className="ab-row-diff-del">−{change.removed}</span>}
    </span>
  );
}

/** A menu anchored where the pointer was, dismissed by Escape or a click out. */
function PageContextMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div
        className="fixed inset-0"
        style={{ zIndex: "var(--z-dropdown)" }}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label="Page actions"
        className="ab-menu fixed"
        style={{ top: y, left: x, minWidth: 168 }}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <button role="menuitem" className="ab-menu-item" onClick={onRename}>
          Rename
        </button>
        <div className="ab-menu-sep" />
        <button
          role="menuitem"
          className="ab-menu-item is-danger"
          onClick={onDelete}
        >
          Delete page
        </button>
      </div>
    </>
  );
}
