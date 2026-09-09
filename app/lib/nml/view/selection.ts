import {
  AllSelection,
  NodeSelection,
  Selection,
  TextSelection,
} from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import type { NmlYjsIndex } from "../yjs";
import type { NodePositionEntry, PositionIndex } from "./position-index";
import { nmlInlineOffsetToPm, pmInlineOffsetToNml } from "./projection";

export type NmlPoint =
  | { kind: "text"; nodeId: string; relative: Uint8Array; affinity: "before" | "after" }
  | { kind: "node"; nodeId: string; side: "before" | "on" | "after" };

export type NmlSelection = {
  anchor: NmlPoint;
  head: NmlPoint;
};

type WirePoint =
  | { kind: "text"; nodeId: string; relative: number[]; affinity: "before" | "after" }
  | { kind: "node"; nodeId: string; side: "before" | "on" | "after" };

export type NmlAwarenessSelection = {
  version: 1;
  anchor: WirePoint;
  head: WirePoint;
};

function editableEntryAt(position: number, index: PositionIndex, yjs: NmlYjsIndex): NodePositionEntry | null {
  for (const candidate of [index.nodeAt(position), position > 0 ? index.nodeAt(position - 1) : null]) {
    let entry = candidate;
    while (entry) {
      if (entry.contentStart !== undefined && position >= entry.contentStart && position <= entry.pmEnd - 1 && yjs.text(entry.nodeId)) return entry;
      entry = entry.parentId ? index.get(entry.parentId) ?? null : null;
    }
  }
  return null;
}

function nodePointAt(position: number, index: PositionIndex): NmlPoint | null {
  const next = index.nodeAt(position);
  if (next && position <= next.pmStart) return { kind: "node", nodeId: next.nodeId, side: "before" };
  const previous = position > 0 ? index.nodeAt(position - 1) : null;
  if (previous && position >= previous.pmEnd) return { kind: "node", nodeId: previous.nodeId, side: "after" };
  const entry = next ?? previous;
  return entry ? { kind: "node", nodeId: entry.nodeId, side: "on" } : null;
}

function pointAt(
  position: number,
  affinity: "before" | "after",
  doc: PmNode,
  index: PositionIndex,
  yjs: NmlYjsIndex,
): NmlPoint | null {
  const entry = editableEntryAt(position, index, yjs);
  if (entry) {
    const node = doc.nodeAt(entry.pmStart);
    const offset = node ? pmInlineOffsetToNml(node, position - entry.contentStart!) : position - entry.contentStart!;
    const relative = yjs.createRelativeTextPosition(entry.nodeId, offset, affinity);
    if (relative) return { kind: "text", nodeId: entry.nodeId, relative, affinity };
  }
  return nodePointAt(position, index);
}

function documentBoundary(index: PositionIndex, first: boolean): NmlPoint | null {
  const entries = [...index.byId.values()]
    .filter((entry) => entry.parentId === null)
    .sort((a, b) => a.pmStart - b.pmStart);
  const entry = first ? entries[0] : entries.at(-1);
  return entry ? { kind: "node", nodeId: entry.nodeId, side: first ? "before" : "after" } : null;
}

export function selectionToNml(
  selection: Selection,
  doc: PmNode,
  index: PositionIndex,
  yjs: NmlYjsIndex,
): NmlSelection | null {
  if (selection instanceof AllSelection) {
    const anchor = documentBoundary(index, true);
    const head = documentBoundary(index, false);
    return anchor && head ? { anchor, head } : null;
  }
  if (selection instanceof NodeSelection) {
    const nodeId = selection.node.attrs.nmlId;
    if (typeof nodeId === "string") {
      const point = { kind: "node", nodeId, side: "on" } as const;
      return { anchor: point, head: point };
    }
  }
  const forward = selection.anchor <= selection.head;
  const anchorAffinity = selection.empty ? "after" : forward ? "after" : "before";
  const headAffinity = selection.empty ? "after" : forward ? "before" : "after";
  const anchor = pointAt(selection.anchor, anchorAffinity, doc, index, yjs);
  const head = pointAt(selection.head, headAffinity, doc, index, yjs);
  return anchor && head ? { anchor, head } : null;
}

function fallbackPosition(
  point: NmlPoint,
  index: PositionIndex,
  yjs: NmlYjsIndex,
  previousOrder: readonly string[],
): number | null {
  const live = previousOrder.filter((id) => !!index.get(id));
  if (!live.length) return null;
  const liveIds = new Set(live);
  const deletedAt = previousOrder.indexOf(point.nodeId);
  const preferBefore = point.kind === "text" ? point.affinity === "before" : point.side === "before";
  if (deletedAt >= 0) {
    const before = previousOrder.slice(0, deletedAt).reverse().find((id) => liveIds.has(id));
    const after = previousOrder.slice(deletedAt + 1).find((id) => liveIds.has(id));
    const chosen = preferBefore ? before ?? after : after ?? before;
    if (chosen) {
      const entry = index.get(chosen)!;
      const editable = yjs.text(chosen) && entry.contentStart !== undefined;
      return chosen === before
        ? editable ? entry.pmEnd - 1 : entry.pmEnd
        : editable ? entry.contentStart! : entry.pmStart;
    }
  }
  const first = index.get(live[0])!;
  return yjs.text(first.nodeId) && first.contentStart !== undefined ? first.contentStart : first.pmStart;
}

function pointPosition(
  point: NmlPoint,
  doc: PmNode,
  index: PositionIndex,
  yjs: NmlYjsIndex,
  previousOrder: readonly string[],
): number | null {
  const entry = index.get(point.nodeId);
  if (point.kind === "text" && entry?.contentStart !== undefined) {
    const offset = yjs.resolveRelativeTextPosition(point.nodeId, point.relative);
    const node = doc.nodeAt(entry.pmStart);
    if (offset !== null && node) return Math.min(
      entry.pmEnd - 1,
      entry.contentStart + nmlInlineOffsetToPm(node, offset, point.affinity),
    );
  }
  if (point.kind === "node" && entry) {
    if (point.side === "before" || point.side === "on") return entry.pmStart;
    return entry.pmEnd;
  }
  return fallbackPosition(point, index, yjs, previousOrder);
}

export function selectionFromNml(
  selection: NmlSelection,
  doc: PmNode,
  index: PositionIndex,
  yjs: NmlYjsIndex,
  previousOrder: readonly string[] = [],
): Selection {
  const roots = [...index.byId.values()]
    .filter((entry) => entry.parentId === null)
    .sort((left, right) => left.pmStart - right.pmStart);
  if (roots.length && selection.anchor.kind === "node" && selection.head.kind === "node" &&
      selection.anchor.nodeId === roots[0].nodeId && selection.anchor.side === "before" &&
      selection.head.nodeId === roots.at(-1)!.nodeId && selection.head.side === "after") {
    return new AllSelection(doc);
  }
  if (selection.anchor.kind === "node" && selection.head.kind === "node" &&
      selection.anchor.side === "on" && selection.head.side === "on" &&
      selection.anchor.nodeId === selection.head.nodeId) {
    const entry = index.get(selection.anchor.nodeId);
    const node = entry ? doc.nodeAt(entry.pmStart) : null;
    if (entry && node && NodeSelection.isSelectable(node)) return NodeSelection.create(doc, entry.pmStart);
  }
  const anchor = pointPosition(selection.anchor, doc, index, yjs, previousOrder);
  const head = pointPosition(selection.head, doc, index, yjs, previousOrder);
  if (anchor === null || head === null) return Selection.atStart(doc);
  const boundedAnchor = Math.max(0, Math.min(doc.content.size, anchor));
  const boundedHead = Math.max(0, Math.min(doc.content.size, head));
  if (boundedAnchor === boundedHead && !doc.resolve(boundedAnchor).parent.inlineContent) {
    const side = selection.head.kind === "node" && selection.head.side === "before" ? -1 : 1;
    return Selection.near(doc.resolve(boundedHead), side);
  }
  return TextSelection.between(doc.resolve(boundedAnchor), doc.resolve(boundedHead));
}

function pointToWire(point: NmlPoint): WirePoint {
  return point.kind === "text" ? { ...point, relative: Array.from(point.relative) } : { ...point };
}

export function serializeAwarenessSelection(selection: NmlSelection): NmlAwarenessSelection {
  return { version: 1, anchor: pointToWire(selection.anchor), head: pointToWire(selection.head) };
}

function pointFromWire(value: unknown): NmlPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<WirePoint>;
  if (typeof point.nodeId !== "string" || point.nodeId.length === 0 || point.nodeId.length > 512) return null;
  if (point.kind === "node" && (point.side === "before" || point.side === "on" || point.side === "after")) {
    return { kind: "node", nodeId: point.nodeId, side: point.side };
  }
  if (point.kind === "text" && (point.affinity === "before" || point.affinity === "after") &&
      Array.isArray(point.relative) && point.relative.length > 0 && point.relative.length <= 256 &&
      point.relative.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return { kind: "text", nodeId: point.nodeId, affinity: point.affinity, relative: Uint8Array.from(point.relative) };
  }
  return null;
}

export function parseAwarenessSelection(value: unknown): NmlSelection | null {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return null;
  const candidate = value as { anchor?: unknown; head?: unknown };
  const anchor = pointFromWire(candidate.anchor);
  const head = pointFromWire(candidate.head);
  return anchor && head ? { anchor, head } : null;
}
