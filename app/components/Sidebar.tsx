"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { track } from "@/app/lib/telemetry";
import {
  ArrowLeft,
  ChevronRight,
  FileDoc,
  Folder,
  FolderPlus,
  PanelLeft,
  Plus,
} from "./Icons";
import { AccountMenu } from "./AccountMenu";
import { ShareDialog } from "./ShareDialog";
import { ConfirmDeleteDialog } from "./ConfirmDelete";
import { ContextDialog } from "./context/ContextDialog";
import { ContextMenu } from "./ContextMenu";
import { Editable } from "./Editable";
import { usePageChanges, type PageChange } from "./ReviewContext";
import { useHints } from "./hints/useHints";
import { useTreeDrag, type TreeRow } from "./sidebarDrag";

/** Indent per tree level, mirroring the drop line's inline offset. */
const INDENT = 12;

type Props = {
  width: number;
  projectId: Id<"projects">;
  /** The focused pane's page — the one the chat and the agent are pointed at. */
  selectedPageId: Id<"pages"> | null;
  /** The other pane's page while the surface is split, so both rows read open. */
  otherPageId: Id<"pages"> | null;
  onSelectPage: (id: Id<"pages">) => void;
  /** Where a row dragged out of the list lands, and the page it opens beside. */
  splitZone: RefObject<HTMLElement | null>;
  onOpenAside: (id: Id<"pages">) => void;
  onCollapse: () => void;
};

/** A row's identity, the way the clipboard, the menus and a rename hold it. */
type Target =
  | { kind: "page"; id: Id<"pages"> }
  | { kind: "folder"; id: Id<"folders"> };

type Row =
  | {
      kind: "folder";
      folder: Doc<"folders">;
      parentId: Id<"folders"> | null;
      depth: number;
      expanded: boolean;
    }
  | {
      kind: "page";
      page: Doc<"pages">;
      parentId: Id<"folders"> | null;
      depth: number;
    };

/**
 * The visible tree in render order: each level's folders above its pages, both
 * by their own `order`, depth-first through expanded folders. A row whose
 * parent is gone — or caught in a cycle two concurrent moves could leave —
 * surfaces at the top level rather than vanishing.
 */
function flattenTree(
  folders: readonly Doc<"folders">[],
  pages: readonly Doc<"pages">[],
  collapsed: ReadonlySet<string>,
): Row[] {
  const known = new Set<string>(folders.map((f) => f._id));
  const home = (id: Id<"folders"> | undefined): Id<"folders"> | null =>
    id && known.has(id) ? id : null;
  const byOrder = (a: { order: number }, b: { order: number }) =>
    a.order - b.order;

  const out: Row[] = [];
  const seen = new Set<string>();
  const walk = (parentId: Id<"folders"> | null, depth: number) => {
    const level = folders
      .filter((f) => home(f.parentId) === parentId && !seen.has(f._id))
      .sort(byOrder);
    for (const folder of level) {
      seen.add(folder._id);
      const expanded = !collapsed.has(folder._id);
      out.push({ kind: "folder", folder, parentId, depth, expanded });
      if (expanded) walk(folder._id, depth + 1);
    }
    for (const page of pages
      .filter((p) => home(p.folderId) === parentId)
      .sort(byOrder)) {
      out.push({ kind: "page", page, parentId, depth });
    }
  };
  walk(null, 0);
  for (const folder of folders) {
    if (seen.has(folder._id)) continue;
    seen.add(folder._id);
    const expanded = !collapsed.has(folder._id);
    out.push({ kind: "folder", folder, parentId: null, depth: 0, expanded });
    if (expanded) walk(folder._id, 1);
  }
  return out;
}

export function Sidebar({
  width,
  projectId,
  selectedPageId,
  otherPageId,
  onSelectPage,
  splitZone,
  onOpenAside,
  onCollapse,
}: Props) {
  const project = useQuery(api.projects.get, { projectId });
  const pages = useQuery(api.pages.listByProject, { projectId });
  const folders = useQuery(api.folders.listByProject, { projectId });
  const repos = useQuery(api.github.repos.listForProject, { projectId });
  // What this sidebar may offer: editors get the page verbs, only the owner
  // gets the project's own — sharing, renaming it, its context sheet.
  const role = useQuery(api.projects.myRole, { projectId });
  const owner = role === "owner";
  const canEdit = owner || role === "editor";
  const changes = usePageChanges();
  const hints = useHints();
  const createPage = useMutation(api.pages.create);
  const renamePage = useMutation(api.pages.rename);
  const removePage = useMutation(api.pages.remove);
  const movePage = useMutation(api.pages.move);
  const duplicatePage = useMutation(api.pages.duplicate);
  const createFolder = useMutation(api.folders.create);
  const renameFolder = useMutation(api.folders.rename);
  const removeFolder = useMutation(api.folders.remove);
  const moveFolder = useMutation(api.folders.move);
  const duplicateFolder = useMutation(api.folders.duplicate);
  const renameProject = useMutation(api.projects.rename);

  const [editing, setEditing] = useState<Target | { kind: "project" } | null>(
    null,
  );
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [showingContext, setShowingContext] = useState(false);
  const [draft, setDraft] = useState("");
  /** The row the keyboard verbs act on — the last one clicked or right-clicked. */
  const [selected, setSelected] = useState<Target | null>(null);
  /** What ⌘C/⌘X holds until ⌘V spends it; "cut" is spent, "copy" is not. */
  const [clip, setClip] = useState<(Target & { op: "copy" | "cut" }) | null>(
    null,
  );
  /** Where a right-click opened a menu, and on what, in viewport coordinates. */
  const [ctx, setCtx] = useState<{
    target: Target | { kind: "list" };
    x: number;
    y: number;
  } | null>(null);

  /**
   * Folders the user closed, per project. Lazy-initialized from localStorage —
   * no rows render until the queries resolve on the client, so the value never
   * differs across the hydration boundary — and written through on toggle.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const held = window.localStorage.getItem(`nt-collapsed:${projectId}`);
      return new Set(held ? (JSON.parse(held) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const persistCollapsed = (next: ReadonlySet<string>) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(
        `nt-collapsed:${projectId}`,
        JSON.stringify([...next]),
      );
    } catch {
      // Private mode: the tree still works, it just forgets on reload.
    }
  };
  const toggleFolder = (id: Id<"folders">) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    persistCollapsed(next);
  };
  const expand = (id: Id<"folders"> | null | undefined) => {
    if (!id || !collapsed.has(id)) return;
    const next = new Set(collapsed);
    next.delete(id);
    persistCollapsed(next);
  };

  const rows = flattenTree(folders ?? [], pages ?? [], collapsed);
  const dragRows: TreeRow[] = rows.map((r) =>
    r.kind === "folder"
      ? {
          kind: "folder",
          id: r.folder._id,
          parentId: r.parentId,
          depth: r.depth,
          expanded: r.expanded,
        }
      : { kind: "page", id: r.page._id, parentId: r.parentId, depth: r.depth },
  );

  const knownFolders = new Set<string>((folders ?? []).map((f) => f._id));
  const home = (id: Id<"folders"> | undefined): Id<"folders"> | null =>
    id && knownFolders.has(id) ? id : null;
  const pageById = (id: Id<"pages">) => pages?.find((p) => p._id === id);
  const folderById = (id: Id<"folders">) => folders?.find((f) => f._id === id);
  const lastPageIn = (parentId: Id<"folders"> | null): Id<"pages"> | null => {
    const level = (pages ?? []).filter((p) => home(p.folderId) === parentId);
    if (!level.length) return null;
    return level.reduce((m, p) => (p.order > m.order ? p : m))._id;
  };
  const lastFolderIn = (
    parentId: Id<"folders"> | null,
  ): Id<"folders"> | null => {
    const level = (folders ?? []).filter((f) => home(f.parentId) === parentId);
    if (!level.length) return null;
    return level.reduce((m, f) => (f.order > m.order ? f : m))._id;
  };
  /** True when `candidate` sits at or under `root` — the folder-cycle guard. */
  const isInside = (
    candidate: Id<"folders">,
    root: Id<"folders">,
  ): boolean => {
    const byId = new Map((folders ?? []).map((f) => [f._id, f]));
    const seen = new Set<string>();
    for (
      let node = byId.get(candidate);
      node && !seen.has(node._id);
      node = node.parentId ? byId.get(node.parentId) : undefined
    ) {
      if (node._id === root) return true;
      seen.add(node._id);
    }
    return false;
  };

  const listRef = useRef<HTMLUListElement>(null);
  const drag = useTreeDrag(
    listRef,
    dragRows,
    {
      onMovePage: (id, parentId, after) => {
        void movePage({
          pageId: id,
          folderId: parentId ?? undefined,
          after: (after === "end" ? lastPageIn(parentId) : after) ?? undefined,
        });
        expand(parentId);
        track("page_moved", {});
      },
      onMoveFolder: (id, parentId, after) => {
        void moveFolder({
          folderId: id,
          parentId: parentId ?? undefined,
          after: (after === "end" ? lastFolderIn(parentId) : after) ?? undefined,
        });
        expand(parentId);
        track("folder_moved", {});
      },
      onExpand: expand,
      forbids: (folderId, parentId) => isInside(parentId, folderId),
    },
    {
      zone: splitZone,
      isOpen: (id) => id === selectedPageId || id === otherPageId,
      onDrop: onOpenAside,
    },
  );

  const commit = () => {
    const title = draft.trim();
    if (!editing) return;
    if (editing.kind === "project") {
      if (title) renameProject({ projectId, title });
    } else if (editing.kind === "page") {
      // Empty is allowed: the row falls back to "Untitled".
      renamePage({ pageId: editing.id, title });
    } else {
      renameFolder({ folderId: editing.id, title });
    }
    setEditing(null);
  };

  const startRename = (
    who: Target | { kind: "project" },
    current: string,
  ) => {
    setDraft(current);
    setEditing(who);
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

  const newPage = (folderId?: Id<"folders">) => {
    createPage({ projectId, folderId }).then((id) => {
      track("page_created", {});
      expand(folderId);
      setSelected({ kind: "page", id });
      onSelectPage(id);
    });
  };

  const newFolder = (parentId?: Id<"folders">) => {
    createFolder({ projectId, parentId }).then((id) => {
      track("folder_created", {});
      expand(parentId);
      setSelected({ kind: "folder", id });
      // Instant edit-on-insert, like every other thing this app creates.
      startRename({ kind: "folder", id }, "");
    });
  };

  /**
   * Spends the clipboard into a folder (null = top level). A cut is a move and
   * is spent; a copy is a deep duplicate and keeps, so ⌘V can stamp it again.
   */
  const pasteInto = (dest: Id<"folders"> | null) => {
    if (!clip) return;
    if (clip.kind === "folder" && dest && isInside(dest, clip.id)) return;
    if (clip.op === "cut") {
      if (clip.kind === "page" && pageById(clip.id)) {
        void movePage({
          pageId: clip.id,
          folderId: dest ?? undefined,
          after: lastPageIn(dest) ?? undefined,
        });
      } else if (clip.kind === "folder" && folderById(clip.id)) {
        void moveFolder({
          folderId: clip.id,
          parentId: dest ?? undefined,
          after: lastFolderIn(dest) ?? undefined,
        });
      }
      setClip(null);
    } else {
      if (clip.kind === "page" && pageById(clip.id)) {
        void duplicatePage({ pageId: clip.id, folderId: dest ?? undefined });
      } else if (clip.kind === "folder" && folderById(clip.id)) {
        void duplicateFolder({ folderId: clip.id, parentId: dest ?? undefined });
      }
    }
    expand(dest);
    track("sidebar_pasted", { kind: clip.kind, op: clip.op });
  };

  /** The folder a paste lands in, read off the selection the way VS Code does. */
  const pasteDest = (): Id<"folders"> | null => {
    if (!selected) return null;
    if (selected.kind === "folder") return selected.id;
    return home(pageById(selected.id)?.folderId);
  };

  /**
   * The folder a drop or a paste would land in — one ring, one meaning. The
   * selected folder is deliberately NOT washed: the open page owns that mark,
   * and two persistent highlights of the same weight say nothing. A folder
   * answers a click by opening, which is its own acknowledgement.
   */
  const landing = drag.intoId ?? (clip ? pasteDest() : null);

  /**
   * ⌘C / ⌘X / ⌘V over the tree, heard while focus is on one of its rows.
   * Handled on keydown rather than the clipboard events because the payload
   * is a row, not text — nothing here belongs on the system clipboard.
   */
  const navKeys = (e: React.KeyboardEvent) => {
    if (!canEdit || editing) return;
    if (e.key === "Escape" && clip) {
      setClip(null);
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (key === "c" || key === "x") {
      if (!selected) return;
      e.preventDefault();
      setClip({ ...selected, op: key === "c" ? "copy" : "cut" });
    } else if (key === "v") {
      if (!clip) return;
      e.preventDefault();
      pasteInto(pasteDest());
    }
  };

  const openMenu = (
    e: React.MouseEvent,
    target: Target | { kind: "list" },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (target.kind !== "list") setSelected(target);
    setCtx({ target, x: e.clientX, y: e.clientY });
  };

  const confirmingRow =
    confirming?.kind === "page"
      ? pageById(confirming.id)
      : confirming
        ? folderById(confirming.id)
        : undefined;
  const confirmingTitle = confirmingRow?.title || "Untitled";

  return (
    <aside style={{ width }} className="nt-panel nt-rail-l" aria-label="Pages">
      {/* Back to the project list, the way a docs app returns to your files —
          there is no project switcher here because the route is the project. */}
      <div className="nt-panel-head">
        <Link href="/" className="nt-row min-w-0 flex-1 text-muted" title="All projects">
          <ArrowLeft width={14} height={14} className="shrink-0" />
          <span className="nt-row-label">Projects</span>
        </Link>
        {owner && <ShareDialog projectId={projectId} />}
        <AccountMenu />
        <button
          onClick={onCollapse}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="nt-icon-btn"
        >
          <PanelLeft />
        </button>
      </div>

      <div className="px-2 pb-2">
        {editing?.kind === "project" ? (
          <Editable
            autoFocus
            value={draft}
            label="Project name"
            onInput={setDraft}
            onBlur={commit}
            onKeyDown={keys}
            className="nt-row-edit w-full font-semibold"
          />
        ) : (
          <button
            onDoubleClick={
              owner ? () => startRename({ kind: "project" }, project?.title ?? "") : undefined
            }
            title={owner ? "Double-click to rename" : undefined}
            className="nt-row w-full font-semibold"
          >
            <span className="nt-row-label">
              {project?.title || "Untitled project"}
            </span>
          </button>
        )}
      </div>

      <nav
        className="flex-1 overflow-y-auto px-2 pb-2"
        onKeyDown={navKeys}
        onContextMenu={
          canEdit ? (e) => openMenu(e, { kind: "list" }) : undefined
        }
      >
        {/* Above the pages because it is above them: what holds for the whole
            project, and the one place a repository can be attached to it.
            Owner-only — the sheet is the project's, and its dialog manages it. */}
        {owner && (
          <button
            onClick={() => setShowingContext(true)}
            title="What the assistant knows about this project"
            className="nt-row w-full"
          >
            <span className="nt-row-label">Context</span>
            {!!repos?.length && <span className="nt-field-note">{repos.length}</span>}
          </button>
        )}

        <div className="nt-section-label mt-1">
          <span>Pages</span>
          {canEdit && (
            <span className="flex">
              <button
                onClick={() => newFolder()}
                aria-label="New folder"
                title="New folder"
                className="nt-icon-btn"
              >
                <FolderPlus width={14} height={14} />
              </button>
              <button
                onClick={() => newPage()}
                aria-label="New page"
                title="New page"
                className="nt-icon-btn"
              >
                <Plus />
              </button>
            </span>
          )}
        </div>

        <ul
          ref={listRef}
          className={`nt-pages relative space-y-px${otherPageId ? " is-split" : ""}`}
        >
          {rows.length === 0 && (
            <li className="px-2 py-1 text-[13px] text-muted">
              {canEdit ? "No pages yet — press + to add one." : "No pages yet."}
            </li>
          )}
          {rows.map((row, i) => {
            const id = row.kind === "folder" ? row.folder._id : row.page._id;
            const target: Target =
              row.kind === "folder"
                ? { kind: "folder", id: row.folder._id }
                : { kind: "page", id: row.page._id };
            const isEditing =
              editing?.kind === row.kind && editing.id === id;
            const isCut = clip?.op === "cut" && clip.id === id;
            const indent = {
              paddingLeft: `calc(var(--inset) + ${row.depth * INDENT}px)`,
            };
            if (isEditing) {
              return (
                <li key={id} data-row={id}>
                  <div style={{ paddingLeft: row.depth * INDENT }}>
                    <Editable
                      autoFocus
                      value={draft}
                      label={row.kind === "folder" ? "Folder name" : "Page name"}
                      onInput={setDraft}
                      onBlur={commit}
                      onKeyDown={keys}
                      className="nt-row-edit is-selected w-full"
                    />
                  </div>
                </li>
              );
            }
            if (row.kind === "folder") {
              return (
                <li key={id} data-row={id}>
                  <button
                    onClick={() => {
                      setSelected(target);
                      toggleFolder(row.folder._id);
                    }}
                    onPointerDown={
                      canEdit ? (e) => drag.press(dragRows[i], e) : undefined
                    }
                    onDoubleClick={
                      canEdit
                        ? () => startRename(target, row.folder.title)
                        : undefined
                    }
                    onContextMenu={
                      canEdit ? (e) => openMenu(e, target) : undefined
                    }
                    title={
                      canEdit
                        ? "Double-click to rename · right-click for more"
                        : undefined
                    }
                    aria-expanded={row.expanded}
                    className={`nt-row w-full${
                      drag.dragId === id ? " is-dragging" : ""
                    }${landing === id ? " is-into" : ""}${
                      isCut ? " is-cut" : ""
                    }`}
                    style={indent}
                  >
                    <span className="nt-row-twist">
                      <ChevronRight
                        width={12}
                        height={12}
                        className={`nt-row-chevron${row.expanded ? " is-open" : ""}`}
                      />
                    </span>
                    <Folder width={14} height={14} className="nt-row-icon" />
                    <span className="nt-row-label">
                      {row.folder.title || "Untitled"}
                    </span>
                  </button>
                </li>
              );
            }
            return (
              <li key={id} data-row={id}>
                <button
                  onClick={() => {
                    // Switching pages is the structure lesson being learned.
                    if (row.page._id !== selectedPageId) hints.die("sidebar");
                    setSelected(target);
                    onSelectPage(row.page._id);
                  }}
                  onPointerDown={
                    canEdit ? (e) => drag.press(dragRows[i], e) : undefined
                  }
                  onDoubleClick={
                    canEdit ? () => startRename(target, row.page.title) : undefined
                  }
                  onContextMenu={canEdit ? (e) => openMenu(e, target) : undefined}
                  title={
                    canEdit
                      ? "Double-click to rename · right-click for more"
                      : undefined
                  }
                  aria-current={
                    selectedPageId === row.page._id ? "page" : undefined
                  }
                  className={`nt-row w-full${
                    selectedPageId === row.page._id
                      ? " is-selected"
                      : otherPageId === row.page._id
                        ? " is-open"
                        : ""
                  }${drag.dragId === id ? " is-dragging" : ""}${
                    isCut ? " is-cut" : ""
                  }`}
                  style={indent}
                >
                  <span className="nt-row-twist" />
                  <FileDoc width={14} height={14} className="nt-row-icon" />
                  <span className="nt-row-label">
                    {row.page.title || "Untitled"}
                  </span>
                  <ChangeCount change={changes.get(row.page._id)} />
                </button>
              </li>
            );
          })}
          {/* Last child, so the space-y margins of the real rows stay put. */}
          {drag.line && (
            <li
              aria-hidden
              className="nt-drop-line"
              style={{ top: drag.line.top, left: 4 + drag.line.depth * INDENT }}
            />
          )}
        </ul>

        {/* The structure, said once in the sidebar's own voice: gone forever
            the first time they switch pages. */}
        {hints.alive("sidebar") && (
          <p className="px-2 py-1.5 text-[13px] leading-snug text-muted">
            The pages of this project. Projects, above, is home.
          </p>
        )}
      </nav>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          label={
            ctx.target.kind === "folder"
              ? "Folder actions"
              : ctx.target.kind === "page"
                ? "Page actions"
                : "Pages"
          }
          onClose={() => setCtx(null)}
        >
          {ctx.target.kind === "list" && (
            <>
              <Item onClick={() => { newPage(); setCtx(null); }}>New page</Item>
              <Item onClick={() => { newFolder(); setCtx(null); }}>
                New folder
              </Item>
              {clip && (
                <>
                  <div className="nt-menu-sep" />
                  <Item onClick={() => { pasteInto(null); setCtx(null); }}>
                    Paste
                  </Item>
                </>
              )}
            </>
          )}
          {ctx.target.kind === "folder" && (
            <FolderMenu
              id={ctx.target.id}
              hasClip={!!clip}
              onNewPage={newPage}
              onNewFolder={newFolder}
              onCut={(id) => setClip({ kind: "folder", id, op: "cut" })}
              onCopy={(id) => setClip({ kind: "folder", id, op: "copy" })}
              onPaste={(id) => pasteInto(id)}
              onRename={(id) =>
                startRename({ kind: "folder", id }, folderById(id)?.title ?? "")
              }
              onDelete={(id) => setConfirming({ kind: "folder", id })}
              onClose={() => setCtx(null)}
            />
          )}
          {ctx.target.kind === "page" && (
            <PageMenu
              id={ctx.target.id}
              hasClip={!!clip}
              onCut={(id) => setClip({ kind: "page", id, op: "cut" })}
              onCopy={(id) => setClip({ kind: "page", id, op: "copy" })}
              onPaste={(id) => pasteInto(home(pageById(id)?.folderId))}
              onRename={(id) =>
                startRename({ kind: "page", id }, pageById(id)?.title ?? "")
              }
              onDelete={(id) => setConfirming({ kind: "page", id })}
              onClose={() => setCtx(null)}
            />
          )}
        </ContextMenu>
      )}

      {showingContext && (
        <ContextDialog
          projectId={projectId}
          onClose={() => setShowingContext(false)}
        />
      )}

      {confirming && (
        <ConfirmDeleteDialog
          title={confirmingTitle}
          what={
            confirming.kind === "folder"
              ? `“${confirmingTitle}” and everything inside it`
              : undefined
          }
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            if (confirming.kind === "page") {
              removePage({ pageId: confirming.id });
            } else {
              removeFolder({ folderId: confirming.id });
            }
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
      className="nt-row-diff"
      title={`${change.added} added, ${change.removed} removed, awaiting review`}
    >
      {change.added > 0 && <span className="nt-row-diff-add">+{change.added}</span>}
      {change.removed > 0 && <span className="nt-row-diff-del">−{change.removed}</span>}
    </span>
  );
}

function Item({
  danger,
  onClick,
  children,
}: {
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="menuitem"
      className={`nt-menu-item${danger ? " is-danger" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** VS Code's explorer menu for a folder: create at the top, destroy at the bottom. */
function FolderMenu({
  id,
  hasClip,
  onNewPage,
  onNewFolder,
  onCut,
  onCopy,
  onPaste,
  onRename,
  onDelete,
  onClose,
}: {
  id: Id<"folders">;
  hasClip: boolean;
  onNewPage: (id: Id<"folders">) => void;
  onNewFolder: (id: Id<"folders">) => void;
  onCut: (id: Id<"folders">) => void;
  onCopy: (id: Id<"folders">) => void;
  onPaste: (id: Id<"folders">) => void;
  onRename: (id: Id<"folders">) => void;
  onDelete: (id: Id<"folders">) => void;
  onClose: () => void;
}) {
  const act = (fn: (id: Id<"folders">) => void) => () => {
    fn(id);
    onClose();
  };
  return (
    <>
      <Item onClick={act(onNewPage)}>New page</Item>
      <Item onClick={act(onNewFolder)}>New folder</Item>
      <div className="nt-menu-sep" />
      <Item onClick={act(onCut)}>Cut</Item>
      <Item onClick={act(onCopy)}>Copy</Item>
      {hasClip && <Item onClick={act(onPaste)}>Paste</Item>}
      <div className="nt-menu-sep" />
      <Item onClick={act(onRename)}>Rename</Item>
      <div className="nt-menu-sep" />
      <Item danger onClick={act(onDelete)}>
        Delete folder
      </Item>
    </>
  );
}

function PageMenu({
  id,
  hasClip,
  onCut,
  onCopy,
  onPaste,
  onRename,
  onDelete,
  onClose,
}: {
  id: Id<"pages">;
  hasClip: boolean;
  onCut: (id: Id<"pages">) => void;
  onCopy: (id: Id<"pages">) => void;
  onPaste: (id: Id<"pages">) => void;
  onRename: (id: Id<"pages">) => void;
  onDelete: (id: Id<"pages">) => void;
  onClose: () => void;
}) {
  const act = (fn: (id: Id<"pages">) => void) => () => {
    fn(id);
    onClose();
  };
  return (
    <>
      <Item onClick={act(onCut)}>Cut</Item>
      <Item onClick={act(onCopy)}>Copy</Item>
      {hasClip && <Item onClick={act(onPaste)}>Paste</Item>}
      <div className="nt-menu-sep" />
      <Item onClick={act(onRename)}>Rename</Item>
      <div className="nt-menu-sep" />
      <Item danger onClick={act(onDelete)}>
        Delete page
      </Item>
    </>
  );
}
