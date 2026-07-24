"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ChevronsUpDown, PanelLeft, Plus } from "./Icons";
import { Editable } from "./Editable";

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

  const [switcherOpen, setSwitcherOpen] = useState(false);
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
      className="flex h-full shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="px-1 text-sm font-semibold tracking-tight">auto-board</span>
        <button
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          className="rounded p-1 text-muted hover:bg-black/5 hover:text-foreground"
        >
          <PanelLeft />
        </button>
      </div>

      {/* Pages fill the sidebar; the project switcher is pinned at the bottom. */}
      <div className="flex-1 overflow-y-auto px-2">
        <SectionLabel
          label="Pages"
          onAdd={
            selectedProjectId
              ? () => createPage({ projectId: selectedProjectId }).then(onSelectPage)
              : undefined
          }
        />
        <ul className="mt-1 space-y-0.5">
          {!selectedProjectId && (
            <li className="px-2 py-1 text-xs text-muted">No project selected</li>
          )}
          {sortedPages?.map((pg) => (
            <li key={pg._id}>
              {editingId === pg._id ? (
                <Editable
                  autoFocus
                  value={draft}
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
                  // Visually identical to the selected row — no box, just a caret.
                  className="w-full truncate rounded-md bg-black/5 px-2 py-1 text-sm font-medium outline-none"
                />
              ) : (
                <button
                  onClick={() => onSelectPage(pg._id)}
                  onDoubleClick={() => {
                    setEditingId(pg._id);
                    setDraft(pg.title);
                  }}
                  title="Double-click to rename"
                  className={`w-full truncate rounded-md px-2 py-1 text-left text-sm ${
                    selectedPageId === pg._id
                      ? "bg-black/5 font-medium"
                      : "text-foreground/80 hover:bg-black/5"
                  }`}
                >
                  {pg.title || "Untitled"}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Project switcher */}
      <div className="relative border-t border-border p-2">
        {switcherOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setSwitcherOpen(false)}
            />
            <div className="absolute bottom-full left-2 right-2 z-20 mb-1 overflow-hidden rounded-lg border border-border bg-background shadow-lg">
              <ul className="max-h-64 overflow-y-auto py-1">
                {projects?.map((p) => (
                  <li key={p._id}>
                    <button
                      onClick={() => {
                        onSelectProject(p._id);
                        setSwitcherOpen(false);
                      }}
                      className={`w-full truncate px-3 py-1.5 text-left text-sm hover:bg-black/5 ${
                        selectedProjectId === p._id ? "font-medium" : ""
                      }`}
                    >
                      {p.title}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => {
                  createProject({ title: "Untitled project" }).then((id) => {
                    onSelectProject(id);
                    setSwitcherOpen(false);
                  });
                }}
                className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-muted hover:bg-black/5 hover:text-foreground"
              >
                <Plus width={14} height={14} /> New project
              </button>
            </div>
          </>
        )}
        <button
          onClick={() => setSwitcherOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 hover:bg-black/5"
        >
          <span className="truncate text-sm font-medium">
            {currentProject?.title ?? "No project"}
          </span>
          <ChevronsUpDown className="shrink-0 text-muted" />
        </button>
      </div>
    </aside>
  );
}

function SectionLabel({
  label,
  onAdd,
}: {
  label: string;
  onAdd?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 pt-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {onAdd && (
        <button
          onClick={onAdd}
          aria-label={`Add ${label}`}
          className="rounded p-0.5 text-muted hover:bg-black/5 hover:text-foreground"
        >
          <Plus width={14} height={14} />
        </button>
      )}
    </div>
  );
}
