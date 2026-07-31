/**
 * Auto-layout — a group's CSS, resolved to concrete child rects.
 *
 * A group with `display: flex` or `display: grid` in its `style` positions its
 * children; a group without one leaves them where they were authored. This
 * module is the only place that maths is done, and it is done from the model
 * alone: it never reads a real DOM box. Measuring a paint would make layout
 * depend on a frame having happened, which is unusable for the AI layer (no
 * DOM), for the serializer (must round-trip without rendering) and for a drag
 * (needs the answer before the frame, not after it).
 *
 * The rects it returns are in the **parent's coordinate space** — the same
 * space as an authored `x`/`y` — so a caller can use them interchangeably with
 * a plain group's children.
 *
 * Nesting is the caller's business: {@link resolveLayout} sizes children from
 * the `w`/`h` they already have. A group of hugging groups is resolved
 * bottom-up — {@link measureGroup} the inner ones, then the outer.
 */

import { isGroup, LAYOUT_STYLE_PROPS } from "./types";
import type {
  AlignItems,
  FlexDirection,
  GroupLayout,
  GroupNode,
  JustifyContent,
  LayoutMode,
  NodeId,
  Padding,
  Rect,
  Scene,
  SceneLike,
  SceneNode,
  StyleMap,
} from "./types";

const NO_PADDING: Padding = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * What a group with no layout declarations means.
 *
 * `alignItems` defaults to `flex-start` rather than CSS's `normal`, because
 * every child here has a definite width and height — which is exactly the case
 * in which CSS's `normal` resolves to start rather than stretching.
 */
export const DEFAULT_LAYOUT: GroupLayout = {
  mode: "none",
  flexDirection: "row",
  gap: 0,
  padding: NO_PADDING,
  alignItems: "flex-start",
  justifyContent: "flex-start",
  gridTemplateColumns: "",
};

// ---------------------------------------------------------------------------
// Reading the layout off `style`
// ---------------------------------------------------------------------------

function decl(style: StyleMap, prop: string): string | undefined {
  const raw = style[prop];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

function keyword(style: StyleMap, prop: string): string | undefined {
  return decl(style, prop)?.toLowerCase();
}

const LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(?:px)?$/i;

/** A CSS length in px. Percentages, `calc()` and font-relative units are not
 * resolvable without a container or a font, so they fall back. */
function length(value: string | undefined, fallback: number): number {
  const match = value === undefined ? null : LENGTH.exec(value.trim());
  return match ? Number.parseFloat(match[1]) : fallback;
}

/** Which of flex / grid / absolute this group is. */
export function layoutModeOf(group: GroupNode): LayoutMode {
  switch (keyword(group.style, LAYOUT_STYLE_PROPS.mode)) {
    case "flex":
    case "inline-flex":
      return "flex";
    case "grid":
    case "inline-grid":
      return "grid";
    default:
      return "none";
  }
}

/** True when this group positions its children rather than obeying their `x`/`y`. */
export function isAutoLayout(group: GroupNode): boolean {
  return layoutModeOf(group) !== "none";
}

const FLEX_DIRECTIONS: readonly FlexDirection[] = [
  "row",
  "row-reverse",
  "column",
  "column-reverse",
];

const ALIGN_ITEMS: Record<string, AlignItems> = {
  "flex-start": "flex-start",
  start: "flex-start",
  normal: "flex-start",
  center: "center",
  "flex-end": "flex-end",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

const JUSTIFY_CONTENT: Record<string, JustifyContent> = {
  "flex-start": "flex-start",
  start: "flex-start",
  left: "flex-start",
  normal: "flex-start",
  center: "center",
  "flex-end": "flex-end",
  end: "flex-end",
  right: "flex-end",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly",
};

/**
 * A group's `gap`.
 *
 * A two-value `gap` names a row gap and a column gap; {@link GroupLayout} holds
 * one number, so the row gap wins and the original declaration stays in `style`
 * to round-trip. This is the simplification the contract sanctions, not a loss.
 */
function parseGap(style: StyleMap): number {
  const value = decl(style, LAYOUT_STYLE_PROPS.gap);
  if (value === undefined) return 0;
  return length(value.split(/\s+/)[0], 0);
}

/** The `padding` shorthand, then any longhand that overrides it. */
function parsePadding(style: StyleMap): Padding {
  const parts = decl(style, LAYOUT_STYLE_PROPS.padding)?.split(/\s+/) ?? [];
  const at = (i: number) => length(parts[i], 0);
  const padding: Padding =
    parts.length === 0
      ? { ...NO_PADDING }
      : parts.length === 1
        ? { top: at(0), right: at(0), bottom: at(0), left: at(0) }
        : parts.length === 2
          ? { top: at(0), right: at(1), bottom: at(0), left: at(1) }
          : parts.length === 3
            ? { top: at(0), right: at(1), bottom: at(2), left: at(1) }
            : { top: at(0), right: at(1), bottom: at(2), left: at(3) };

  padding.top = length(decl(style, "padding-top"), padding.top);
  padding.right = length(decl(style, "padding-right"), padding.right);
  padding.bottom = length(decl(style, "padding-bottom"), padding.bottom);
  padding.left = length(decl(style, "padding-left"), padding.left);
  return padding;
}

/**
 * The group's layout as data — derived from `style` on every read, never
 * stored, so hand-written and AI-written CSS behave identically to the
 * sidebar's.
 */
export function layoutOf(group: GroupNode): GroupLayout {
  const style = group.style;
  const direction = keyword(style, LAYOUT_STYLE_PROPS.flexDirection);
  const align = keyword(style, LAYOUT_STYLE_PROPS.alignItems);
  const justify = keyword(style, LAYOUT_STYLE_PROPS.justifyContent);
  return {
    mode: layoutModeOf(group),
    flexDirection: FLEX_DIRECTIONS.find((d) => d === direction) ?? "row",
    gap: parseGap(style),
    padding: parsePadding(style),
    alignItems: (align && ALIGN_ITEMS[align]) || DEFAULT_LAYOUT.alignItems,
    justifyContent:
      (justify && JUSTIFY_CONTENT[justify]) || DEFAULT_LAYOUT.justifyContent,
    gridTemplateColumns:
      decl(style, LAYOUT_STYLE_PROPS.gridTemplateColumns) ?? "",
  };
}

// ---------------------------------------------------------------------------
// Shared axis maths
// ---------------------------------------------------------------------------

const isRow = (d: FlexDirection) => d === "row" || d === "row-reverse";
const isReverse = (d: FlexDirection) => d.endsWith("-reverse");

/**
 * Where the first item starts and how far apart consecutive items sit.
 *
 * The negative-free-space cases are CSS's, not ours: `space-between` falls back
 * to start and `space-around` / `space-evenly` fall back to centre when the
 * content overflows.
 */
function mainOffsets(
  justify: JustifyContent,
  free: number,
  gap: number,
  count: number,
): { start: number; between: number } {
  if (count === 0) return { start: 0, between: gap };
  switch (justify) {
    case "flex-start":
      return { start: 0, between: gap };
    case "center":
      return { start: free / 2, between: gap };
    case "flex-end":
      return { start: free, between: gap };
    case "space-between": {
      if (count === 1 || free <= 0) return { start: 0, between: gap };
      return { start: 0, between: gap + free / (count - 1) };
    }
    case "space-around": {
      if (free <= 0) return { start: free / 2, between: gap };
      const unit = free / count;
      return { start: unit / 2, between: gap + unit };
    }
    case "space-evenly": {
      if (free <= 0) return { start: free / 2, between: gap };
      const unit = free / (count + 1);
      return { start: unit, between: gap + unit };
    }
  }
}

/**
 * The cross-axis offset of an item inside a `extent`-tall line.
 *
 * `baseline` needs font metrics this module cannot have, so it behaves as
 * `flex-start` — the same place a single-line baseline alignment would put it.
 */
function crossOffset(align: AlignItems, extent: number, size: number): number {
  switch (align) {
    case "center":
      return (extent - size) / 2;
    case "flex-end":
      return extent - size;
    case "flex-start":
    case "baseline":
    case "stretch":
      return 0;
  }
}

/** Positional alignment only; the `space-*` values are meaningless per-item. */
function inlineOffset(
  justify: JustifyContent,
  extent: number,
  size: number,
): number {
  if (justify === "center") return (extent - size) / 2;
  if (justify === "flex-end") return extent - size;
  return 0;
}

// ---------------------------------------------------------------------------
// Flex
// ---------------------------------------------------------------------------

function flexRects(group: GroupNode, layout: GroupLayout): Map<NodeId, Rect> {
  const rects = new Map<NodeId, Rect>();
  const { padding: pad, gap, alignItems } = layout;
  const horizontal = isRow(layout.flexDirection);
  const order = isReverse(layout.flexDirection)
    ? [...group.children].reverse()
    : group.children;

  const mainSize = (n: SceneNode) => (horizontal ? n.w : n.h);
  const crossSize = (n: SceneNode) => (horizontal ? n.h : n.w);
  const mainExtent = horizontal
    ? group.w - pad.left - pad.right
    : group.h - pad.top - pad.bottom;
  const crossExtent = horizontal
    ? group.h - pad.top - pad.bottom
    : group.w - pad.left - pad.right;

  let content = gap * Math.max(0, order.length - 1);
  for (const child of order) content += mainSize(child);

  const { start, between } = mainOffsets(
    layout.justifyContent,
    mainExtent - content,
    gap,
    order.length,
  );

  let cursor = start;
  for (const child of order) {
    const cross = alignItems === "stretch" ? crossExtent : crossSize(child);
    const offset = crossOffset(alignItems, crossExtent, cross);
    rects.set(
      child.id,
      horizontal
        ? {
            x: pad.left + cursor,
            y: pad.top + offset,
            w: child.w,
            h: cross,
          }
        : {
            x: pad.left + offset,
            y: pad.top + cursor,
            w: cross,
            h: child.h,
          },
    );
    cursor += mainSize(child) + between;
  }
  return rects;
}

function flexSize(group: GroupNode, layout: GroupLayout): { w: number; h: number } {
  const { padding: pad, gap } = layout;
  const horizontal = isRow(layout.flexDirection);
  let main = gap * Math.max(0, group.children.length - 1);
  let cross = 0;
  for (const child of group.children) {
    main += horizontal ? child.w : child.h;
    cross = Math.max(cross, horizontal ? child.h : child.w);
  }
  return horizontal
    ? { w: main + pad.left + pad.right, h: cross + pad.top + pad.bottom }
    : { w: cross + pad.left + pad.right, h: main + pad.top + pad.bottom };
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

type Track =
  | { unit: "px"; value: number }
  | { unit: "fr"; value: number }
  | { unit: "pct"; value: number }
  | { unit: "auto" };

/** Split a track list on whitespace, keeping `repeat(…)` in one piece. */
function tokenizeTracks(spec: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of spec) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (token) out.push(token);
      token = "";
      continue;
    }
    token += ch;
  }
  if (token) out.push(token);
  return out;
}

function parseTrack(token: string): Track {
  const value = Number.parseFloat(token);
  if (Number.isFinite(value)) {
    if (/fr$/i.test(token)) return { unit: "fr", value };
    if (/%$/.test(token)) return { unit: "pct", value };
    if (/^-?[\d.]+(px)?$/i.test(token)) return { unit: "px", value };
  }
  return { unit: "auto" };
}

/**
 * `grid-template-columns` as a flat track list. `repeat(n, …)` is expanded;
 * `auto-fill` / `auto-fit` need a definite container to count against and are
 * treated as a single repetition rather than guessed at.
 */
function parseTracks(spec: string): Track[] {
  const tracks: Track[] = [];
  for (const token of tokenizeTracks(spec.trim())) {
    const repeat = /^repeat\((.*)\)$/i.exec(token);
    if (!repeat) {
      tracks.push(parseTrack(token));
      continue;
    }
    const comma = repeat[1].indexOf(",");
    if (comma === -1) continue;
    const count = Number.parseInt(repeat[1].slice(0, comma), 10);
    const inner = tokenizeTracks(repeat[1].slice(comma + 1).trim()).map(parseTrack);
    for (let i = 0; i < (Number.isFinite(count) ? Math.max(0, count) : 1); i++) {
      tracks.push(...inner);
    }
  }
  return tracks;
}

/**
 * Resolve tracks to px.
 *
 * `extent` is the content-box width, or `null` when measuring — with no
 * container to divide, a flexible track can only be as wide as what is in it.
 * When nothing is flexible, leftover space is shared by the `auto` tracks,
 * which is what CSS's default `justify-content: normal` does to them.
 */
function trackSizes(
  tracks: readonly Track[],
  extent: number | null,
  content: readonly number[],
  gap: number,
): number[] {
  const sizes = tracks.map((track, i) => {
    switch (track.unit) {
      case "px":
        return track.value;
      case "pct":
        return extent === null ? content[i] : (track.value / 100) * extent;
      case "fr":
      case "auto":
        return content[i];
    }
  });
  if (extent === null) return sizes;

  const used = sizes.reduce((a, b) => a + b, 0) + gap * Math.max(0, tracks.length - 1);
  const free = extent - used;

  const frTotal = tracks.reduce((a, t) => a + (t.unit === "fr" ? t.value : 0), 0);
  if (frTotal > 0) {
    // An `fr` track is not content-sized: it starts at zero and takes its share.
    const fixed =
      sizes.reduce((a, b, i) => a + (tracks[i].unit === "fr" ? 0 : b), 0) +
      gap * Math.max(0, tracks.length - 1);
    const flexible = Math.max(0, extent - fixed);
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track.unit === "fr") sizes[i] = (track.value / frTotal) * flexible;
    }
    return sizes;
  }

  const autoCount = tracks.filter((t) => t.unit === "auto").length;
  if (free > 0 && autoCount > 0) {
    const share = free / autoCount;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].unit === "auto") sizes[i] += share;
    }
  }
  return sizes;
}

type Grid = {
  tracks: Track[];
  columns: number[];
  rows: number[];
};

/** Column widths and row heights. `extent` is null when measuring. */
function grid(group: GroupNode, layout: GroupLayout, extent: number | null): Grid {
  const tracks = parseTracks(layout.gridTemplateColumns);
  if (tracks.length === 0) tracks.push({ unit: "auto" });

  const content = tracks.map(() => 0);
  const rows: number[] = [];
  group.children.forEach((child, i) => {
    const column = i % tracks.length;
    const row = Math.floor(i / tracks.length);
    content[column] = Math.max(content[column], child.w);
    rows[row] = Math.max(rows[row] ?? 0, child.h);
  });

  return { tracks, columns: trackSizes(tracks, extent, content, layout.gap), rows };
}

function gridRects(group: GroupNode, layout: GroupLayout): Map<NodeId, Rect> {
  const rects = new Map<NodeId, Rect>();
  const { padding: pad, gap } = layout;
  const { columns, rows } = grid(
    group,
    layout,
    group.w - pad.left - pad.right,
  );

  const offsets = (sizes: readonly number[]) => {
    const out: number[] = [];
    let at = 0;
    for (const size of sizes) {
      out.push(at);
      at += size + gap;
    }
    return out;
  };
  const columnAt = offsets(columns);
  const rowAt = offsets(rows);

  group.children.forEach((child, i) => {
    const c = i % columns.length;
    const r = Math.floor(i / columns.length);
    const h = layout.alignItems === "stretch" ? rows[r] : child.h;
    rects.set(child.id, {
      x: pad.left + columnAt[c] + inlineOffset(layout.justifyContent, columns[c], child.w),
      y: pad.top + rowAt[r] + crossOffset(layout.alignItems, rows[r], h),
      w: child.w,
      h,
    });
  });
  return rects;
}

function gridSize(group: GroupNode, layout: GroupLayout): { w: number; h: number } {
  const { padding: pad, gap } = layout;
  const { columns, rows } = grid(group, layout, null);
  const sum = (sizes: readonly number[]) =>
    sizes.reduce((a, b) => a + b, 0) + gap * Math.max(0, sizes.length - 1);
  return {
    w: (group.children.length ? sum(columns) : 0) + pad.left + pad.right,
    h: (rows.length ? sum(rows) : 0) + pad.top + pad.bottom,
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Every direct child's box, keyed by id, in the group's coordinate space.
 *
 * Total: a plain group returns each child's authored rect, so the renderer and
 * the hit-tester have exactly one lookup path and never branch on the mode.
 * Hidden children keep their slot — `hidden` means "not painted", and having a
 * child silently reflow its siblings by disappearing is the kind of surprise
 * that makes a layout feel unpredictable.
 */
export function resolveLayout(group: GroupNode): Map<NodeId, Rect> {
  const layout = layoutOf(group);
  if (layout.mode === "flex") return flexRects(group, layout);
  if (layout.mode === "grid") return gridRects(group, layout);

  const rects = new Map<NodeId, Rect>();
  for (const child of group.children) {
    rects.set(child.id, { x: child.x, y: child.y, w: child.w, h: child.h });
  }
  return rects;
}

/**
 * The size this group would have if it hugged its contents.
 *
 * For an auto-layout group that is the flow's own extent plus padding; for a
 * plain group it is how far its children reach from the group's origin, which
 * is what "shrink the box onto what is inside it" means when the children set
 * their own positions.
 */
export function measureGroup(group: GroupNode): { w: number; h: number } {
  const layout = layoutOf(group);
  if (layout.mode === "flex") return flexSize(group, layout);
  if (layout.mode === "grid") return gridSize(group, layout);

  let w = 0;
  let h = 0;
  for (const child of group.children) {
    w = Math.max(w, child.x + child.w);
    h = Math.max(h, child.y + child.h);
  }
  return { w, h };
}

// ---------------------------------------------------------------------------
// The whole scene, laid out
// ---------------------------------------------------------------------------

const LAID_OUT = new WeakMap<object, SceneLike>();

function placeNode(node: SceneNode): SceneNode {
  if (!isGroup(node)) return node;
  const rects = isAutoLayout(node) ? resolveLayout(node) : null;
  let changed = false;
  const children = node.children.map((child) => {
    const r = rects?.get(child.id);
    const moved =
      r &&
      (r.x !== child.x || r.y !== child.y || r.w !== child.w || r.h !== child.h)
        ? { ...child, x: r.x, y: r.y, w: r.w, h: r.h }
        : child;
    const next = placeNode(moved);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function placeAll(nodes: readonly SceneNode[]): readonly SceneNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    const next = placeNode(node);
    if (next !== node) changed = true;
    return next;
  });
  return changed ? out : nodes;
}

/**
 * The scene with every auto-layout group's children moved to where the layout
 * actually puts them.
 *
 * The browser positions a flex or grid group's children, so their authored
 * `x`/`y` describe nowhere — and everything that reads the model would draw and
 * grab them there: the selection frame, the hover outline, a marquee, the
 * snapper, a gesture's start state. Rewriting the boxes once, here, is what lets
 * all of those keep reading plain `x`/`y` and be right, without a single one of
 * them measuring a rendered element.
 *
 * Only positions change; ids, styles, order and identity of untouched subtrees
 * are preserved, so a scene with no auto-layout in it is returned as it came.
 * Memoised per scene object, because several callers want the same tree in the
 * same frame, and idempotent, because some of them hand it back.
 */
export function laidOutScene<T extends SceneLike>(scene: T): T {
  const cached = LAID_OUT.get(scene);
  if (cached) return cached as T;
  const nodes = Array.isArray(scene) ? scene : (scene as Scene).nodes;
  const placed = placeAll(nodes);
  const out = (
    placed === nodes
      ? scene
      : Array.isArray(scene)
        ? placed
        : { ...(scene as Scene), nodes: placed as SceneNode[] }
  ) as T;
  LAID_OUT.set(scene, out);
  LAID_OUT.set(out, out);
  return out;
}

/** Figma's "hug", written as the CSS that means it. */
export const HUG = "fit-content";

/** Which axes are sized by their contents rather than by `w`/`h`. */
export function hugsOf(group: GroupNode): { w: boolean; h: boolean } {
  return {
    w: keyword(group.style, "width") === HUG,
    h: keyword(group.style, "height") === HUG,
  };
}

/**
 * The group's box with every hugging axis resolved against its contents.
 *
 * The renderer paints `w`/`h`, so `fit-content` only takes effect if the model
 * is kept in step with it — that is `reflowHugs` in `./ops`, which is where
 * every mutation ends up. Returns the group's own size when neither axis hugs.
 */
export function hugSize(group: GroupNode): { w: number; h: number } {
  const hug = hugsOf(group);
  if (!hug.w && !hug.h) return { w: group.w, h: group.h };
  const size = measureGroup(group);
  return { w: hug.w ? size.w : group.w, h: hug.h ? size.h : group.h };
}
