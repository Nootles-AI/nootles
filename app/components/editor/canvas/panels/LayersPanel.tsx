"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Editable } from "@/app/components/Editable";
import { ChevronRight } from "@/app/components/Icons";
import { useContextMenu } from "../ContextMenu";
import { SHORTCUTS_BY_ID } from "../engine/shortcuts";
import { useSceneSnapshot, type SceneStore } from "../engine/useScene";
import type { SelectionStore } from "../engine/useSelection";
import { unitPolygon } from "../scene/geometry";
import {
  displayName,
  findNode,
  isContainer,
  nodePath,
  type NodeId,
  type Scene,
  type SceneNode,
  type SceneNodeKind,
} from "../scene/types";
import "./layers.css";

/** Mirrors the row height in layers.css; the drag maths needs it as a number. */
const ROW_H = 24;
const INDENT = 12;
const DRAG_SLOP = 4;

interface Row {
  node: SceneNode;
  depth: number;
  parentId: NodeId | null;
  /** Index among its siblings in **document order** (back-to-front). */
  index: number;
}

/**
 * Where a drag would land, as a document-order insertion point.
 *
 * `index` counts the destination's children **as they are now**; the removal of
 * the dragged nodes is compensated for at dispatch, because `reorder` counts
 * positions in the list after they are taken out.
 */
interface Drop {
  parentId: NodeId | null;
  index: number;
  /** Set when the drop lands on a group's row rather than between two rows. */
  intoId?: NodeId;
  /** Indicator geometry, in scroller px. Unused when `intoId` is set. */
  top: number;
  depth: number;
}

/**
 * Front-most at top.
 *
 * The scene stores nodes back-to-front — document order *is* z-order — so every
 * sibling list is walked in reverse here. This panel is the only place that
 * flips it; `index` stays the document index so drops need no translation.
 */
function flatten(
  nodes: readonly SceneNode[],
  expanded: ReadonlySet<NodeId>,
  parentId: NodeId | null,
  depth: number,
  out: Row[],
): Row[] {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    out.push({ node, depth, parentId, index: i });
    if (isContainer(node) && expanded.has(node.id)) {
      flatten(node.children, expanded, node.id, depth + 1, out);
    }
  }
  return out;
}

function childList(scene: Scene, parentId: NodeId | null): readonly SceneNode[] {
  if (parentId === null) return scene.nodes;
  const node = findNode(scene, parentId);
  return node && isContainer(node) ? node.children : [];
}

/** A group may not be dropped into itself or into its own descendants. */
function accepts(
  scene: Scene,
  parentId: NodeId | null,
  moving: ReadonlySet<NodeId>,
): boolean {
  if (parentId === null) return true;
  return !nodePath(scene, parentId).some((node) => moving.has(node.id));
}

function withAncestors(
  expanded: ReadonlySet<NodeId>,
  scene: Scene,
  ids: readonly NodeId[],
): ReadonlySet<NodeId> {
  let next: Set<NodeId> | null = null;
  for (const id of ids) {
    for (const node of nodePath(scene, id).slice(0, -1)) {
      if (!expanded.has(node.id)) (next ??= new Set(expanded)).add(node.id);
    }
  }
  return next ?? expanded;
}

function computeDrop(
  scene: Scene,
  rows: readonly Row[],
  expanded: ReadonlySet<NodeId>,
  moving: ReadonlySet<NodeId>,
  y: number,
): Drop | null {
  const at = (parentId: NodeId | null, index: number, top: number, depth: number) =>
    accepts(scene, parentId, moving) ? { parentId, index, top, depth } : null;

  // Past the last row: the back of the root list, which an expanded group at
  // the bottom would otherwise make unreachable.
  if (rows.length === 0 || y >= rows.length * ROW_H) {
    return at(null, 0, rows.length * ROW_H, 0);
  }

  const i = Math.max(0, Math.floor(y / ROW_H));
  const row = rows[i];
  const frac = y / ROW_H - i;
  const group = isContainer(row.node) ? row.node : null;

  if (group && frac > 0.25 && frac < 0.75) {
    if (!accepts(scene, group.id, moving)) return null;
    return {
      parentId: group.id,
      index: group.children.length,
      intoId: group.id,
      top: i * ROW_H,
      depth: row.depth,
    };
  }
  // Above a row is in front of it, and the panel is reversed — so one past its
  // document index.
  if (frac < 0.5) {
    return at(row.parentId, row.index + 1, i * ROW_H, row.depth);
  }
  if (group && expanded.has(group.id)) {
    return at(group.id, group.children.length, (i + 1) * ROW_H, row.depth + 1);
  }
  return at(row.parentId, row.index, (i + 1) * ROW_H, row.depth);
}

/**
 * Read off the keymap table rather than spelled out again, so the panel and the
 * canvas cannot bind different keys to the same command. Both of them are plain
 * keys, hence the bare modifier test.
 */
const DELETE_KEYS: ReadonlySet<string> = new Set(
  SHORTCUTS_BY_ID["edit.delete"].keys,
);

function isDeleteKey(e: React.KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return DELETE_KEYS.has(e.key.toLowerCase());
}

function sameDrop(a: Drop | null, b: Drop | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.parentId === b.parentId && a.index === b.index && a.intoId === b.intoId;
}

export function LayersPanel({
  store,
  selection,
}: {
  store: SceneStore;
  selection: SelectionStore;
}) {
  const scene = useSceneSnapshot(store);
  const snapshot = useSyncExternalStore(
    selection.subscribe,
    selection.getSnapshot,
    selection.getSnapshot,
  );

  const [expanded, setExpanded] = useState<ReadonlySet<NodeId>>(
    () => new Set<NodeId>(),
  );
  const [renaming, setRenaming] = useState<{ id: NodeId; draft: string } | null>(
    null,
  );
  const [moving, setMoving] = useState<ReadonlySet<NodeId> | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const { open: openMenu, menu } = useContextMenu(store, selection);

  // Selecting a nested shape on the canvas has to reveal it here. Adjusted
  // during render rather than from an effect, so the row exists on the same
  // commit the scroll below runs against.
  const [seenIds, setSeenIds] = useState(snapshot.ids);
  if (seenIds !== snapshot.ids) {
    setSeenIds(snapshot.ids);
    const next = withAncestors(expanded, scene, snapshot.ids);
    if (next !== expanded) setExpanded(next);
  }

  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<NodeId | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const dragRef = useRef<{
    id: NodeId;
    ids: NodeId[];
    moving: Set<NodeId>;
    startY: number;
    listTop: number;
    wasSelected: boolean;
    active: boolean;
  } | null>(null);

  const rows = flatten(scene.nodes, expanded, null, 0, []);

  const lead = snapshot.ids.length ? snapshot.ids[snapshot.ids.length - 1] : null;
  useEffect(() => {
    if (!lead) return;
    listRef.current
      ?.querySelector(`[data-layer="${CSS.escape(lead)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [lead]);

  const toggleExpanded = (id: NodeId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    store.dispatch({ type: "setName", id: renaming.id, name: name || undefined });
    setRenaming(null);
  };

  const endDrag = () => {
    dragRef.current = null;
    dropRef.current = null;
    setMoving(null);
    setDrop(null);
  };

  const onRowPointerDown = (e: React.PointerEvent, row: Row) => {
    const id = row.node.id;
    // The rename field is inside the row; pressing in it must not start a drag.
    if (e.button !== 0 || renaming?.id === id) return;

    if (e.metaKey || e.ctrlKey) {
      selection.toggle(id);
      anchorRef.current = id;
      return;
    }
    if (e.shiftKey && anchorRef.current) {
      const a = rows.findIndex((r) => r.node.id === anchorRef.current);
      const b = rows.findIndex((r) => r.node.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        selection.select(rows.slice(lo, hi + 1).map((r) => r.node.id));
        return;
      }
    }

    // Pressing an already-selected row keeps the whole selection, so a
    // multi-selection can be dragged; the narrowing happens on release.
    const wasSelected = snapshot.selected.has(id);
    if (!wasSelected) selection.select([id]);
    anchorRef.current = id;

    const ids = wasSelected ? [...snapshot.ids] : [id];
    dragRef.current = {
      id,
      ids,
      moving: new Set(ids),
      startY: e.clientY,
      listTop: listRef.current?.getBoundingClientRect().top ?? 0,
      wasSelected,
      active: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onRowPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const list = listRef.current;
    if (!drag || !list) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_SLOP) return;
      drag.active = true;
      setMoving(drag.moving);
    }
    const next = computeDrop(
      scene,
      rows,
      expanded,
      drag.moving,
      e.clientY - drag.listTop + list.scrollTop,
    );
    dropRef.current = next;
    setDrop((prev) => (sameDrop(prev, next) ? prev : next));
  };

  const onRowPointerUp = () => {
    const drag = dragRef.current;
    const target = dropRef.current;
    if (!drag) return;
    if (drag.active) {
      if (target) {
        const siblings = childList(scene, target.parentId);
        let ahead = 0;
        for (let i = 0; i < target.index; i++) {
          if (drag.moving.has(siblings[i].id)) ahead++;
        }
        store.dispatch({
          type: "reorder",
          ids: drag.ids,
          to: {
            at: "index",
            parentId: target.parentId,
            index: target.index - ahead,
          },
        });
      }
    } else if (drag.wasSelected && snapshot.ids.length > 1) {
      selection.select([drag.id]);
    }
    endDrag();
  };

  // Bound to the panel, not to a row: the key has to work wherever focus landed
  // inside it. The canvas keymap only sees keys pressed on the canvas itself.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming || !isDeleteKey(e) || snapshot.ids.length === 0) return;
    e.preventDefault();
    store.dispatch({ type: "remove", ids: [...snapshot.ids] });
    selection.clear();
  };

  return (
    <div className="ab-lyr" aria-label="Layers" onKeyDown={onKeyDown}>
      <div className="ab-section-label">
        <span>Layers</span>
      </div>

      <div
        ref={listRef}
        role="tree"
        aria-label="Layers"
        aria-multiselectable
        className="ab-lyr-list"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) selection.clear();
        }}
      >
        {rows.length === 0 && (
          <div className="ab-lyr-empty">Nothing on the canvas yet.</div>
        )}

        {rows.map((row) => {
          const { node, depth } = row;
          const selected = snapshot.selected.has(node.id);
          const editing = renaming?.id === node.id;
          return (
            <div
              key={node.id}
              data-layer={node.id}
              role="treeitem"
              tabIndex={0}
              aria-level={depth + 1}
              aria-selected={selected}
              aria-expanded={isContainer(node) ? expanded.has(node.id) : undefined}
              className={`ab-lyr-row${selected ? " is-selected" : ""}${
                node.hidden || node.locked ? " is-dim" : ""
              }${moving?.has(node.id) ? " is-moving" : ""}${
                drop?.intoId === node.id ? " is-into" : ""
              }`}
              style={{ paddingLeft: 8 + depth * INDENT }}
              onPointerDown={(e) => onRowPointerDown(e, row)}
              onPointerMove={onRowPointerMove}
              onPointerUp={onRowPointerUp}
              onPointerCancel={endDrag}
              onDoubleClick={() =>
                setRenaming({ id: node.id, draft: displayName(node) })
              }
              // The menu acts on the selection, so a row outside it becomes it.
              onContextMenu={(e) => {
                e.preventDefault();
                if (!snapshot.selected.has(node.id)) selection.select([node.id]);
                openMenu(e);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                selection.select([node.id]);
              }}
            >
              {isContainer(node) ? (
                <button
                  className="ab-lyr-twist"
                  aria-label={expanded.has(node.id) ? "Collapse" : "Expand"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => toggleExpanded(node.id)}
                >
                  <ChevronRight
                    width={12}
                    height={12}
                    className={`ab-lyr-chevron${
                      expanded.has(node.id) ? " is-open" : ""
                    }`}
                  />
                </button>
              ) : (
                <span className="ab-lyr-twist" />
              )}

              <Glyph className="ab-lyr-icon" d={glyphFor(node)} />

              {editing ? (
                <Editable
                  autoFocus
                  value={renaming.draft}
                  label="Layer name"
                  onInput={(text) =>
                    setRenaming({ id: node.id, draft: text })
                  }
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  className="ab-lyr-edit ab-bare-focus"
                />
              ) : (
                <span className="ab-lyr-name">{displayName(node)}</span>
              )}

              <Toggle
                on={node.hidden}
                label={node.hidden ? "Show layer" : "Hide layer"}
                glyph={node.hidden ? EYE_OFF : EYE}
                onClick={() =>
                  store.dispatch({
                    type: "setHidden",
                    ids: [node.id],
                    hidden: !node.hidden,
                  })
                }
              />
              <Toggle
                on={node.locked}
                label={node.locked ? "Unlock layer" : "Lock layer"}
                glyph={node.locked ? LOCKED : UNLOCKED}
                onClick={() =>
                  store.dispatch({
                    type: "setLocked",
                    ids: [node.id],
                    locked: !node.locked,
                  })
                }
              />
            </div>
          );
        })}

        {drop && !drop.intoId && (
          <div
            className="ab-lyr-line"
            style={{ top: drop.top, left: 8 + drop.depth * INDENT }}
          />
        )}
      </div>

      {menu}
    </div>
  );
}

/** Hidden until the row is hovered, latched on once the state is set. */
function Toggle({
  on,
  label,
  glyph,
  onClick,
}: {
  on: boolean;
  label: string;
  glyph: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`ab-lyr-tog${on ? " is-on" : ""}`}
      aria-label={label}
      aria-pressed={on}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      <Glyph d={glyph} />
    </button>
  );
}

/** 12px on the app's 24-unit icon grid. One path per glyph, so they are data. */
function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

const ROUNDED_BOX =
  "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z";
const PADLOCK =
  "M6 10h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z";

const KIND_GLYPH: Record<SceneNodeKind, string> = {
  rect: ROUNDED_BOX,
  ellipse: "M3 12a9 7 0 1 0 18 0 9 7 0 1 0-18 0",
  text: "M5 6h14M12 6v12M9 18h6",
  image: `${ROUNDED_BOX}M4 17l5-4 4 3 3-2 4 3`,
  path: "M4 18C8 6 16 18 20 6",
  // A polygon's own outline is drawn by `glyphFor`; this is only the fallback
  // shape the union demands, and nothing reaches it.
  polygon: "M12 4l8 15H4Z",
  group:
    "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2",
};

/**
 * A polygon's badge is the polygon: drawn from the same unit outline the canvas
 * paints, inset into the 24-box the other glyphs use. One triangle path would
 * have every side count wearing a triangle's badge — a diamond most visibly.
 */
function glyphFor(node: SceneNode): string {
  if (node.kind !== "polygon") return KIND_GLYPH[node.kind];
  const at = (n: number) => Math.round((4 + n * 16) * 10) / 10;
  return `${unitPolygon(node.sides)
    .map((p, i) => `${i ? "L" : "M"}${at(p.x)} ${at(p.y)}`)
    .join("")}Z`;
}

const EYE =
  "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6ZM9.5 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0";
const EYE_OFF =
  "M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c6.5 0 10 6 10 6a17.6 17.6 0 0 1-3.4 3.9M6.4 8.4C3.8 10 2 12 2 12s3.5 6 10 6a10 10 0 0 0 3.7-.7";
const LOCKED = `${PADLOCK}M8 10V7a4 4 0 0 1 8 0v3`;
const UNLOCKED = `${PADLOCK}M8 10V7a4 4 0 0 1 7.6-1.5`;
