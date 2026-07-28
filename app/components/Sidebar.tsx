"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Check, ChevronsUpDown, PanelLeft, Plus, Settings } from "./Icons";
import { Editable } from "./Editable";
import { Menu, MenuItem } from "./Menu";

type Props = {
  width: number;
  selectedProjectId: Id<"projects"> | null;
  selectedPageId: Id<"pages"> | null;
  onSelectProject: (id: Id<"projects">) => void;
  onSelectPage: (id: Id<"pages">) => void;
  onCollapse: () => void;
};

export function Sidebar({
  width,
  selectedProjectId,
  selectedPageId,
  onSelectProject,
  onSelectPage,
  onCollapse,
}: Props) {
  const projects = useQuery(api.projects.list);
  const pages = useQuery(
    api.pages.listByProject,
    selectedProjectId ? { projectId: selectedProjectId } : "skip",
  );
  const createProject = useMutation(api.projects.create);
  const createPage = useMutation(api.pages.create);
  const renamePage = useMutation(api.pages.rename);

  const [editingId, setEditingId] = useState<Id<"pages"> | null>(null);
  const [draft, setDraft] = useState("");

  const currentProject = projects?.find((p) => p._id === selectedProjectId);
  const sortedPages = pages?.slice().sort((a, b) => a.order - b.order);

  const commitRename = () => {
    // Empty is allowed: the sidebar shows an "Untitled" fallback and the doc
    // title falls back to its grayed placeholder.
    if (editingId) renamePage({ pageId: editingId, title: draft.trim() });
    setEditingId(null);
  };

  return (
    <aside
      style={{ width }}
      className="ab-panel border-r border-border"
      aria-label="Pages"
    >
      <div className="ab-panel-head">
        <span className="ab-panel-title">auto-board</span>
        <button
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="ab-icon-btn"
        >
          <PanelLeft />
        </button>
      </div>

      {/* Pages fill the sidebar; the project switcher is pinned at the bottom. */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="ab-section-label">
          <span>Pages</span>
          {selectedProjectId && (
            <button
              onClick={() =>
                createPage({ projectId: selectedProjectId }).then(onSelectPage)
              }
              aria-label="New page"
              title="New page"
              className="ab-icon-btn"
            >
              <Plus />
            </button>
          )}
        </div>

        <ul className="space-y-px">
          {!selectedProjectId && (
            <li className="px-2 py-1 text-[13px] text-muted">
              No project selected
            </li>
          )}
          {sortedPages?.length === 0 && (
            <li className="px-2 py-1 text-[13px] text-muted">
              No pages yet — press + to add one.
            </li>
          )}
          {sortedPages?.map((pg) => (
            <li key={pg._id}>
              {editingId === pg._id ? (
                <Editable
                  autoFocus
                  value={draft}
                  label="Page name"
                  onInput={setDraft}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  // Sits in the same box as the selected row — no field chrome,
                  // just a caret, so renaming doesn't shift the row.
                  className="ab-row is-selected w-full truncate"
                />
              ) : (
                <button
                  onClick={() => onSelectPage(pg._id)}
                  onDoubleClick={() => {
                    setEditingId(pg._id);
                    setDraft(pg.title);
                  }}
                  title="Double-click to rename"
                  aria-current={selectedPageId === pg._id ? "page" : undefined}
                  className={`ab-row w-full${
                    selectedPageId === pg._id ? " is-selected" : ""
                  }`}
                >
                  <span className="ab-row-label">{pg.title || "Untitled"}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border p-2">
        <Menu
          label="Switch project"
          side="top"
          align="start"
          trigger={(p) => (
            <button {...p} className="ab-row w-full">
              <span className="ab-row-label font-medium">
                {currentProject?.title || "No project"}
              </span>
              <ChevronsUpDown className="shrink-0 text-muted" />
            </button>
          )}
        >
          {(close) => (
            <>
              {projects?.map((p) => (
                <MenuItem
                  key={p._id}
                  onClick={() => {
                    onSelectProject(p._id);
                    close();
                  }}
                >
                  <span className="ab-row-label">{p.title || "Untitled"}</span>
                  {p._id === selectedProjectId && (
                    <Check width={14} height={14} className="text-muted" />
                  )}
                </MenuItem>
              ))}
              <div className="ab-menu-sep" />
              <MenuItem
                onClick={() => {
                  createProject({ title: "Untitled project" }).then((id) => {
                    onSelectProject(id);
                    close();
                  });
                }}
              >
                <Plus width={14} height={14} />
                New project
              </MenuItem>
              <Link href="/projects" role="menuitem" className="ab-menu-item">
                <Settings width={14} height={14} />
                Manage projects
              </Link>
            </>
          )}
        </Menu>
      </div>
    </aside>
  );
}
