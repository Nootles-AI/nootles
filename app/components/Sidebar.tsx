"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
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
import { SharePopover } from "./SharePopover";
import { ConfirmDeleteDialog } from "./ConfirmDelete";
import { ContextDialog } from "./context/ContextDialog";
import { ContextMenu } from "./ContextMenu";
import { Editable } from "./Editable";
import { usePageChanges, type PageChange } from "./ReviewContext";
import { useHints } from "./hints/useHints";
import { useTreeDrag, type TreeRow } from "./sidebarDrag";
import { useMarquee } from "./sidebarMarquee";
import {
  flattenTree,
  isInside as isInsideOf,
  rangeBetween,
  rowId,
  targetOf,
  topmost,
  visibleSelection,
  type Target,
  type TreeRowData,
} from "./sidebarTree";

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
  const duplicatePage = useMutation(api.pages.duplicate);
  const createFolder = useMutation(api.folders.create);
  const renameFolder = useMutation(api.folders.rename);
  const removeFolder = useMutation(api.folders.remove);
  const duplicateFolder = useMutation(api.folders.duplicate);
  const moveRows = useMutation(api.tree.move);
  const renameProject = useMutation(api.projects.rename);

  const [editing, setEditing] = useState<Target | { kind: "project" } | null>(
    null,
  );
  const [confirming, setConfirming] = useState<readonly Target[] | null>(null);
  const [showingContext, setShowingContext] = useState(false);
  const [draft, setDraft] = useState("");
  /** The rows the verbs act on. Finder's rules: click, ⌘-click, shift-range. */
  const [selection, setSelection] = useState<readonly Target[]>([]);
  /** Where a shift-range measures from — the last row picked outright. */
  const [anchor, setAnchor] = useState<string | null>(null);
  /** What ⌘C/⌘X holds until ⌘V spends it; "cut" is spent, "copy" is not. */
  const [clip, setClip] = useState<{
    items: readonly Target[];
    op: "copy" | "cut";
  } | null>(null);
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

  // Only what is on screen counts as selected: closing a folder takes its
  // contents out of the selection rather than leaving them acted on unseen.
  const picked = visibleSelection(rows, selection);
  /** The rows a verb runs on — a chosen folder already carries its contents. */
  const acting = topmost(rows, picked);
  const pickedIds = new Set<string>(picked.map((t) => t.id));

  /** Finder's three ways to pick: replace, toggle, or extend from the anchor. */
  const pick = (row: TreeRowData, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    const id = rowId(row);
    if (e.shiftKey && anchor) {
      setSelection(rangeBetween(rows, anchor, id));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelection(
        pickedIds.has(id)
          ? picked.filter((t) => t.id !== id)
          : [...picked, targetOf(row)],
      );
      setAnchor(id);
      return;
    }
    setSelection([targetOf(row)]);
    setAnchor(id);
  };

  const selectOnly = (target: Target) => {
    setSelection([target]);
    setAnchor(target.id);
  };

  const knownFolders = new Set<string>((folders ?? []).map((f) => f._id));
  const home = (id: Id<"folders"> | undefined): Id<"folders"> | null =>
    id && knownFolders.has(id) ? id : null;
  const pageById = (id: Id<"pages">) => pages?.find((p) => p._id === id);
  const folderById = (id: Id<"folders">) => folders?.find((f) => f._id === id);
  /** True when `candidate` sits at or under `root` — the folder-cycle guard. */
  const isInside = (candidate: Id<"folders">, root: Id<"folders">) =>
    isInsideOf(folders ?? [], candidate, root);

  const listRef = useRef<HTMLUListElement>(null);
  const marquee = useMarquee(
    listRef,
    (ids, additive) => {
      const swept = rows.filter((r) => ids.includes(rowId(r))).map(targetOf);
      setSelection(
        additive
          ? [...picked, ...swept.filter((t) => !pickedIds.has(t.id))]
          : swept,
      );
    },
    () => {
      setSelection([]);
      setAnchor(null);
    },
  );
  const drag = useTreeDrag(
    listRef,
    dragRows,
    {
      onMove: (moved, parentId, after) => {
        void moveRows({
          items: moved.map((r) =>
            r.kind === "page"
              ? { kind: "page" as const, id: r.id }
              : { kind: "folder" as const, id: r.id },
          ),
          parentId: parentId ?? undefined,
          after: after === "end" ? undefined : (after ?? undefined),
          atEnd: after === "end",
        });
        expand(parentId);
        if (moved.some((r) => r.kind === "page")) track("page_moved", {});
        if (moved.some((r) => r.kind === "folder")) track("folder_moved", {});
      },
      // Dragging a row that is in the selection takes the whole selection;
      // dragging one outside it leaves the selection alone and carries just it.
      carriedWith: (row) =>
        pickedIds.has(row.id)
          ? dragRows.filter((r) =>
              acting.some((t) => t.id === r.id),
            )
          : [row],
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
      selectOnly({ kind: "page", id });
      onSelectPage(id);
    });
  };

  const newFolder = (parentId?: Id<"folders">) => {
    createFolder({ projectId, parentId }).then((id) => {
      track("folder_created", {});
      expand(parentId);
      selectOnly({ kind: "folder", id });
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
    // A folder cannot be pasted inside itself; the rest of the group still can.
    const items = clip.items.filter(
      (t) =>
        !(t.kind === "folder" && dest && isInside(dest, t.id)) &&
        (t.kind === "page" ? pageById(t.id) : folderById(t.id)),
    );
    if (!items.length) return;

    if (clip.op === "cut") {
      void moveRows({
        items: [...items],
        parentId: dest ?? undefined,
        atEnd: true,
      });
      setClip(null);
    } else {
      // Sequential, so the copies land in the order they were taken.
      void (async () => {
        for (const t of items) {
          if (t.kind === "page") {
            await duplicatePage({ pageId: t.id, folderId: dest ?? undefined });
          } else {
            await duplicateFolder({
              folderId: t.id,
              parentId: dest ?? undefined,
            });
          }
        }
      })();
    }
    expand(dest);
    track("sidebar_pasted", { kind: items[0].kind, op: clip.op });
  };

  /** The folder a paste lands in, read off the selection the way VS Code does. */
  const pasteDest = (): Id<"folders"> | null => {
    const last = picked[picked.length - 1];
    if (!last) return null;
    if (last.kind === "folder") return last.id;
    return home(pageById(last.id)?.folderId);
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
    if (e.key === "Escape") {
      // The pending cut first, then the selection: Escape undoes the most
      // recent thing you did, not everything at once.
      if (clip) setClip(null);
      else setSelection([]);
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (e.shiftKey) return;
    if (key === "a") {
      e.preventDefault();
      setSelection(rows.map(targetOf));
      return;
    }
    if (key === "c" || key === "x") {
      if (!acting.length) return;
      e.preventDefault();
      setClip({ items: acting, op: key === "c" ? "copy" : "cut" });
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
    // A right-click inside the selection keeps it — that is what the menu will
    // act on. One outside it becomes the selection first, as Finder does.
    if (target.kind !== "list" && !pickedIds.has(target.id)) selectOnly(target);
    setCtx({ target, x: e.clientX, y: e.clientY });
  };

  /** What the menu and the confirm dialog are about: the selection, or one row. */
  const subjects = (target: Target): readonly Target[] =>
    pickedIds.has(target.id) && acting.length > 1 ? acting : [target];

  /** What the open menu is about, once the list case is out of the way. */
  const rowSubjects: readonly Target[] =
    ctx && ctx.target.kind !== "list" ? subjects(ctx.target) : [];

  /** A row's current name, for a rename field and for what a dialog is about. */
  const nameOf = (t: Target): string =>
    (t.kind === "page" ? pageById(t.id)?.title : folderById(t.id)?.title) ?? "";

  /** Where a paste aimed at this row lands: the folder itself, or a page's. */
  const destFor = (t: Target): Id<"folders"> | null =>
    t.kind === "folder" ? t.id : home(pageById(t.id)?.folderId);

  const confirmingTitle = confirming?.length
    ? nameOf(confirming[0]) || "Untitled"
    : "";
  const confirmingWhat =
    confirming && confirming.length > 1
      ? `these ${confirming.length} items and everything inside them`
      : confirming?.[0]?.kind === "folder"
        ? `“${confirmingTitle}” and everything inside it`
        : undefined;

  return (
    <aside style={{ width }} className="nt-panel nt-rail-l" aria-label="Pages">
      {/* Back to the project list, the way a docs app returns to your files —
          there is no project switcher here because the route is the project. */}
      <div className="nt-panel-head">
        <Link href="/" className="nt-row min-w-0 flex-1 text-muted" title="All projects">
          <ArrowLeft width={14} height={14} className="shrink-0" />
          <span className="nt-row-label">Projects</span>
        </Link>
        {owner && <SharePopover projectId={projectId} />}
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
        tabIndex={-1}
        onPointerDown={(e) => {
          // Only from genuinely empty space: a press on a row is that row's
          // own gesture, and the scroller is what fills the area below them.
          if (canEdit && (e.target === e.currentTarget || e.target === listRef.current)) {
            marquee.start(e);
          }
        }}
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
          role="tree"
          aria-label="Pages and folders"
          aria-multiselectable
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
            const isCut =
              clip?.op === "cut" && clip.items.some((t) => t.id === id);
            const inSelection = pickedIds.has(id);
            const indent = {
              paddingLeft: `calc(var(--inset) + ${row.depth * INDENT}px)`,
            };
            if (isEditing) {
              // The row keeps its twist and its glyph while being named, so a
              // folder still looks like a folder the whole time it is one —
              // including the moment it is created, which opens straight into
              // this field.
              return (
                <li key={id} data-row={id} role="none">
                  <div className="nt-row is-selected" style={indent}>
                    <span className="nt-row-twist">
                      {row.kind === "folder" && (
                        <ChevronRight
                          width={12}
                          height={12}
                          className={`nt-row-chevron${
                            row.expanded ? " is-open" : ""
                          }`}
                        />
                      )}
                    </span>
                    {row.kind === "folder" ? (
                      <Folder width={14} height={14} className="nt-row-icon" />
                    ) : (
                      <FileDoc width={14} height={14} className="nt-row-icon" />
                    )}
                    <Editable
                      autoFocus
                      value={draft}
                      label={row.kind === "folder" ? "Folder name" : "Page name"}
                      onInput={setDraft}
                      onBlur={commit}
                      onKeyDown={keys}
                      className="nt-row-field"
                    />
                  </div>
                </li>
              );
            }
            if (row.kind === "folder") {
              return (
                <li key={id} data-row={id} role="none">
                  <button
                    onClick={(e) => {
                      pick(row, e);
                      // Only a plain click opens or closes it: extending a
                      // selection through a folder must not also reshape the
                      // list the range was measured against.
                      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                        toggleFolder(row.folder._id);
                      }
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
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-expanded={row.expanded}
                    aria-selected={inSelection}
                    className={`nt-row w-full${
                      inSelection ? " is-selected" : ""
                    }${drag.dragIds.has(id) ? " is-dragging" : ""}${
                      landing === id ? " is-into" : ""
                    }${isCut ? " is-cut" : ""}`}
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
              <li key={id} data-row={id} role="none">
                <button
                  onClick={(e) => {
                    pick(row, e);
                    // Extending or toggling a selection is not a request to
                    // open anything — only a plain click switches the document.
                    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
                    // Switching pages is the structure lesson being learned.
                    if (row.page._id !== selectedPageId) hints.die("sidebar");
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
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-current={
                    selectedPageId === row.page._id ? "page" : undefined
                  }
                  aria-selected={inSelection}
                  className={`nt-row w-full${
                    inSelection ? " is-selected" : ""
                  }${selectedPageId === row.page._id ? " is-current" : ""}${
                    otherPageId === row.page._id ? " is-open" : ""
                  }${drag.dragIds.has(id) ? " is-dragging" : ""}${
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
          {marquee.band && (
            <li aria-hidden className="nt-marquee" style={marquee.band} />
          )}
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

      <DropLabel
        pointer={drag.pointer}
        into={drag.intoId ? folderById(drag.intoId)?.title || "Untitled" : null}
        toRoot={drag.toRoot}
      />

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
          {ctx.target.kind !== "list" && (
            <RowMenu
              subjects={rowSubjects}
              hasClip={!!clip}
              destFor={destFor}
              onNewPage={newPage}
              onNewFolder={newFolder}
              onClip={(op) => setClip({ items: rowSubjects, op })}
              onPaste={pasteInto}
              onRename={(t) => startRename(t, nameOf(t))}
              onDelete={() => setConfirming(rowSubjects)}
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
          what={confirmingWhat}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            for (const t of confirming) {
              if (t.kind === "page") removePage({ pageId: t.id });
              else removeFolder({ folderId: t.id });
            }
            setSelection([]);
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

/**
 * What releasing here will do, said in words beside the pointer.
 *
 * The ring alone answers "which folder", but not "in or beside" — and filing a
 * page somewhere you cannot see the result of is exactly where a drag wants a
 * sentence. Only the two answers that move a page between levels are worth one;
 * a reorder within a level is already fully described by the line.
 *
 * Follows the pointer rather than anchoring to the row, because the pointer is
 * where the eye is during a drag, and flips to the other side near the right
 * edge so it is never clipped.
 */
function DropLabel({
  pointer,
  into,
  toRoot,
}: {
  pointer: { x: number; y: number } | null;
  into: string | null;
  toRoot: boolean;
}) {
  if (!pointer || (!into && !toRoot)) return null;
  const flip = pointer.x > window.innerWidth - 220;
  return (
    <div
      aria-hidden
      className="nt-drag-tip"
      style={{
        top: pointer.y + 18,
        left: pointer.x + (flip ? -12 : 14),
        transform: flip ? "translateX(-100%)" : undefined,
      }}
    >
      {into ? `Into ${into}` : "Out to top level"}
    </div>
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

/**
 * The menu for what was right-clicked: one row, or the selection it belongs to.
 *
 * The verbs that name a single thing — rename, and creating inside a folder —
 * only appear when there is a single thing. The rest read the group, and the
 * delete item says how much it is about to take.
 */
function RowMenu({
  subjects,
  hasClip,
  destFor,
  onNewPage,
  onNewFolder,
  onClip,
  onPaste,
  onRename,
  onDelete,
  onClose,
}: {
  subjects: readonly Target[];
  hasClip: boolean;
  destFor: (t: Target) => Id<"folders"> | null;
  onNewPage: (parent: Id<"folders">) => void;
  onNewFolder: (parent: Id<"folders">) => void;
  onClip: (op: "copy" | "cut") => void;
  onPaste: (dest: Id<"folders"> | null) => void;
  onRename: (t: Target) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const only = subjects.length === 1 ? subjects[0] : null;
  const intoFolder = only?.kind === "folder" ? only.id : null;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const deleteLabel =
    subjects.length > 1
      ? `Delete ${subjects.length} items`
      : only?.kind === "folder"
        ? "Delete folder"
        : "Delete page";

  return (
    <>
      {intoFolder && (
        <>
          <Item onClick={act(() => onNewPage(intoFolder))}>New page</Item>
          <Item onClick={act(() => onNewFolder(intoFolder))}>New folder</Item>
          <div className="nt-menu-sep" />
        </>
      )}
      <Item onClick={act(() => onClip("cut"))}>Cut</Item>
      <Item onClick={act(() => onClip("copy"))}>Copy</Item>
      {hasClip && only && (
        <Item onClick={act(() => onPaste(destFor(only)))}>Paste</Item>
      )}
      {only && (
        <>
          <div className="nt-menu-sep" />
          <Item onClick={act(() => onRename(only))}>Rename</Item>
        </>
      )}
      <div className="nt-menu-sep" />
      <Item danger onClick={act(onDelete)}>
        {deleteLabel}
      </Item>
    </>
  );
}
