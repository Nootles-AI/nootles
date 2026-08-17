"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Dragging a sidebar row through the folder tree — to reorder it, drop it into
 * a folder, or (pages only) out to the surface to open one beside the page
 * already there.
 *
 * Built on pointer events rather than the HTML drag API: the rows keep their
 * click (select), double-click (rename) and right-click (menu), and a drag only
 * begins once the pointer has actually travelled — so a press is still a press.
 *
 * The drop vocabulary is VS Code's. A page carried over a folder row goes into
 * that folder; carried between page rows it takes that gap. A folder carried
 * over another folder splits the row in three — top edge before it, middle into
 * it, bottom edge after it (or first inside, when it is open) — and carried
 * over a page it joins that page's folder. Folders sort before pages at every
 * level, so neither kind ever needs a slot inside the other's group.
 */

const SLOP = 4;
/** Linger this long over a closed folder and it opens under the drag. */
const HOVER_OPEN_MS = 500;

/* Marks the split zone while the pointer is over it. Written straight to the
   element, the way this drag already writes the grabbing cursor to the body:
   the zone belongs to the workspace, and a highlight is not worth a render of
   the two documents inside it. */
const OVER = "nt-drop-aside";

/** One visible row of the sidebar tree, in render order. */
export type TreeRow =
  | {
      kind: "page";
      id: Id<"pages">;
      parentId: Id<"folders"> | null;
      depth: number;
    }
  | {
      kind: "folder";
      id: Id<"folders">;
      parentId: Id<"folders"> | null;
      depth: number;
      expanded: boolean;
    };

/** Sibling anchor for a drop: after this row, at the front, or appended. */
export type DropAnchor<T> = T | null | "end";

type Line = { top: number; depth: number };

type Drop =
  | {
      kind: "page";
      parentId: Id<"folders"> | null;
      after: DropAnchor<Id<"pages">>;
    }
  | {
      kind: "folder";
      parentId: Id<"folders"> | null;
      after: DropAnchor<Id<"folders">>;
    };

type Spot = { drop: Drop; line: Line | null; intoId: Id<"folders"> | null };

type Handlers = {
  onMovePage: (
    id: Id<"pages">,
    parentId: Id<"folders"> | null,
    after: DropAnchor<Id<"pages">>,
  ) => void;
  onMoveFolder: (
    id: Id<"folders">,
    parentId: Id<"folders"> | null,
    after: DropAnchor<Id<"folders">>,
  ) => void;
  /** A closed folder the drag has hovered long enough to want open. */
  onExpand: (id: Id<"folders">) => void;
  /** True when `parentId` is the folder itself or inside its subtree. */
  forbids: (id: Id<"folders">, parentId: Id<"folders">) => boolean;
};

type Aside = {
  /** A drop on the right half of this element opens the page beside the current one. */
  zone: RefObject<HTMLElement | null>;
  /** Already in a pane: the same document in both is not a split. */
  isOpen: (pageId: Id<"pages">) => boolean;
  onDrop: (pageId: Id<"pages">) => void;
};

export function useTreeDrag(
  /** The `<ul>`; rows are its `[data-row]` descendants, in tree order. */
  listRef: RefObject<HTMLUListElement | null>,
  rows: readonly TreeRow[],
  handlers: Handlers,
  aside: Aside,
): {
  /** The row being carried, while one is. */
  dragId: string | null;
  /** Drop line within the list — px from its top, indent depth; null when none. */
  line: Line | null;
  /** Folder row the drop would go into, when it would; drawn as a highlight. */
  intoId: Id<"folders"> | null;
  /** Call from the row's `onPointerDown`. */
  press: (row: TreeRow, event: React.PointerEvent) => void;
} {
  const [drag, setDrag] = useState<{
    id: string;
    line: Line | null;
    intoId: Id<"folders"> | null;
  } | null>(null);

  const rowsRef = useRef(rows);
  const handlersRef = useRef(handlers);
  const asideRef = useRef(aside);
  useEffect(() => {
    rowsRef.current = rows;
    handlersRef.current = handlers;
    asideRef.current = aside;
  });

  /** The visible rows paired with their live rects, in tree order. */
  const measure = (): { row: TreeRow; rect: DOMRect }[] => {
    const list = listRef.current;
    if (!list) return [];
    const byId = new Map(rowsRef.current.map((r) => [r.id as string, r]));
    const out: { row: TreeRow; rect: DOMRect }[] = [];
    for (const el of list.querySelectorAll<HTMLElement>("[data-row]")) {
      const row = byId.get(el.dataset.row ?? "");
      if (row) out.push({ row, rect: el.getBoundingClientRect() });
    }
    return out;
  };

  /** The previous same-parent sibling of the same kind, in render order. */
  const before = (
    rows: readonly TreeRow[],
    i: number,
  ): TreeRow | null => {
    const at = rows[i];
    for (let j = i - 1; j >= 0; j--) {
      const row = rows[j];
      if (row.kind === at.kind && row.parentId === at.parentId) return row;
      // Reached the containing folder: nothing of this kind stands before it.
      if (row.id === at.parentId) return null;
    }
    return null;
  };

  /**
   * The gap a folder appended to `parentId` would land in: its folders sort
   * before its pages, so the line belongs at the first page — or failing one,
   * after the level's last visible row.
   */
  const folderEndLine = (
    measured: { row: TreeRow; rect: DOMRect }[],
    parentId: Id<"folders"> | null,
    listTop: number,
  ): Line | null => {
    const firstPage = measured.find(
      (m) => m.row.kind === "page" && m.row.parentId === parentId,
    );
    if (firstPage) {
      return { top: firstPage.rect.top - listTop, depth: firstPage.row.depth };
    }
    const last = measured[measured.length - 1];
    return last ? { top: last.rect.bottom - listTop, depth: 0 } : null;
  };

  /** Where a pointer height drops the carried row, from the live rows. */
  const spotAt = (carried: TreeRow, clientY: number): Spot | null => {
    const list = listRef.current;
    const measured = measure();
    if (!list || measured.length === 0) return null;
    const listTop = list.getBoundingClientRect().top;
    const { forbids } = handlersRef.current;
    const rows = measured.map((m) => m.row);

    // Past the last row: the top level's end.
    const last = measured[measured.length - 1];
    if (clientY >= last.rect.bottom) {
      if (carried.kind === "page") {
        return {
          drop: { kind: "page", parentId: null, after: "end" },
          line: { top: last.rect.bottom - listTop, depth: 0 },
          intoId: null,
        };
      }
      return {
        drop: { kind: "folder", parentId: null, after: "end" },
        line: folderEndLine(measured, null, listTop),
        intoId: null,
      };
    }

    let i = measured.findIndex((m) => clientY < m.rect.bottom);
    if (i < 0) i = measured.length - 1;
    const { row, rect } = measured[i];
    const frac = Math.min(
      1,
      Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)),
    );

    if (carried.kind === "page") {
      if (row.kind === "folder") {
        return {
          drop: { kind: "page", parentId: row.id, after: "end" },
          line: null,
          intoId: row.id,
        };
      }
      const anchor =
        frac < 0.5 ? ((before(rows, i)?.id as Id<"pages">) ?? null) : row.id;
      return {
        drop: { kind: "page", parentId: row.parentId, after: anchor },
        line: {
          top: (frac < 0.5 ? rect.top : rect.bottom) - listTop,
          depth: row.depth,
        },
        intoId: null,
      };
    }

    // A folder never lands inside itself; a slot beside a row whose parent is
    // in the carried subtree is inside it too.
    const barred = (parentId: Id<"folders"> | null) =>
      parentId !== null && forbids(carried.id, parentId);

    if (row.kind === "page") {
      if (barred(row.parentId)) return null;
      return {
        drop: { kind: "folder", parentId: row.parentId, after: "end" },
        line: row.parentId ? null : folderEndLine(measured, null, listTop),
        intoId: row.parentId,
      };
    }

    if (frac < 0.25) {
      if (barred(row.parentId)) return null;
      return {
        drop: {
          kind: "folder",
          parentId: row.parentId,
          after: (before(rows, i)?.id as Id<"folders">) ?? null,
        },
        line: { top: rect.top - listTop, depth: row.depth },
        intoId: null,
      };
    }
    if (frac < 0.75) {
      if (barred(row.id)) return null;
      return {
        drop: { kind: "folder", parentId: row.id, after: "end" },
        line: null,
        intoId: row.id,
      };
    }
    if (row.expanded) {
      if (barred(row.id)) return null;
      return {
        drop: { kind: "folder", parentId: row.id, after: null },
        line: { top: rect.bottom - listTop, depth: row.depth + 1 },
        intoId: null,
      };
    }
    if (barred(row.parentId)) return null;
    return {
      drop: { kind: "folder", parentId: row.parentId, after: row.id },
      line: { top: rect.bottom - listTop, depth: row.depth },
      intoId: null,
    };
  };

  /** A drop into the slot the row already fills is not a move. */
  const ownSlot = (carried: TreeRow, drop: Drop): boolean => {
    if (drop.after === carried.id) return true;
    if (drop.parentId !== carried.parentId) return false;
    const rows = rowsRef.current;
    const i = rows.findIndex((r) => r.id === carried.id);
    if (i < 0) return false;
    const siblings = rows.filter(
      (r) => r.kind === carried.kind && r.parentId === carried.parentId,
    );
    if (drop.after === null) return siblings[0]?.id === carried.id;
    if (drop.after === "end") {
      return siblings[siblings.length - 1]?.id === carried.id;
    }
    return before(rows, i)?.id === drop.after;
  };

  /** The zone, when a drop here would open the page beside the current one. */
  const asideAt = (row: TreeRow, x: number, y: number): HTMLElement | null => {
    if (row.kind !== "page") return null;
    const side = asideRef.current;
    const zone = side.zone.current;
    if (!zone || side.isOpen(row.id)) return null;
    const r = zone.getBoundingClientRect();
    const over =
      x >= r.left + r.width / 2 && x <= r.right && y >= r.top && y <= r.bottom;
    return over ? zone : null;
  };

  const press = (row: TreeRow, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let spot: Spot | null = null;
    let marked: HTMLElement | null = null;
    let hover: { id: Id<"folders">; since: number } | null = null;

    const mark = (zone: HTMLElement | null) => {
      if (marked === zone) return;
      marked?.classList.remove(OVER);
      zone?.classList.add(OVER);
      marked = zone;
    };

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < SLOP) return;
        started = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      mark(asideAt(row, ev.clientX, ev.clientY));
      // Out over the surface the row is going somewhere else entirely, so the
      // list stops offering it a place in the order.
      spot = marked ? null : spotAt(row, ev.clientY);

      // A closed folder held under the drag opens, so its inside is reachable
      // without letting go.
      const over = spot?.intoId ?? null;
      if (over !== hover?.id) {
        hover = over ? { id: over, since: ev.timeStamp } : null;
      } else if (hover && ev.timeStamp - hover.since > HOVER_OPEN_MS) {
        const target = rowsRef.current.find((r) => r.id === hover?.id);
        if (target?.kind === "folder" && !target.expanded) {
          handlersRef.current.onExpand(hover.id);
        }
        hover = { id: hover.id, since: Infinity };
      }

      setDrag({
        id: row.id,
        line: spot?.line ?? null,
        intoId: spot?.intoId ?? null,
      });
    };

    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", abort);
      mark(null);
      if (!started) return;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      swallowNextClick();
      setDrag(null);
    };

    const drop = (ev: PointerEvent) => {
      const was = started;
      const zone = was ? asideAt(row, ev.clientX, ev.clientY) : null;
      done();
      if (!was) return;
      if (zone && row.kind === "page") {
        asideRef.current.onDrop(row.id);
        return;
      }
      if (!spot || ownSlot(row, spot.drop)) return;
      if (spot.drop.kind === "page" && row.kind === "page") {
        handlersRef.current.onMovePage(row.id, spot.drop.parentId, spot.drop.after);
      } else if (spot.drop.kind === "folder" && row.kind === "folder") {
        handlersRef.current.onMoveFolder(
          row.id,
          spot.drop.parentId,
          spot.drop.after,
        );
      }
    };

    const abort = () => done();

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", abort);
  };

  return {
    dragId: drag?.id ?? null,
    line: drag?.line ?? null,
    intoId: drag?.intoId ?? null,
    press,
  };
}

/**
 * Eats the click a completed drag leaves behind, so releasing over a row does
 * not also select it.
 *
 * On the window rather than the rows, because a drag that starts on one row and
 * ends on another has no click on either: the event is dispatched to their
 * common ancestor, and a flag waiting on a row would still be armed when the
 * user's next real click arrived. This listener either eats that one click or
 * expires on the next task — it can never outlive the drag that set it.
 */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    window.removeEventListener("click", swallow, true);
    clearTimeout(timer);
  };
  const timer = setTimeout(done, 0);
  window.addEventListener("click", swallow, true);
}
