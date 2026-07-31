"use client";

/**
 * The canvas keymap — Figma's, scoped to the canvas.
 *
 * ## Scoping is the whole problem
 *
 * The canvas is a node view inside a ProseMirror document, so every key it
 * wants is a key the editor also wants: ⌘Z, ⌘A, ⌘C, ⌫, the arrows. The listener
 * is therefore bound to the canvas container and every handled event is
 * `stopPropagation`'d there, so the editor's keymap never sees it. That only
 * works because the container is `contentEditable={false}` and focusable: focus
 * lands on it rather than on the editable text around it, keydown originates
 * inside it, and `document.activeElement.isContentEditable` is false — which is
 * exactly the test that tells "the canvas is focused" from "a shape's label is
 * being edited". While a label is being edited nothing here fires.
 *
 * ## The table is the source of truth
 *
 * {@link SHORTCUTS} is data: a label, a group and its bindings. The UI renders
 * it for tooltips and a cheat sheet through {@link shortcutHint}, and the hook
 * dispatches from the same rows, so a shortcut cannot exist in one and not the
 * other.
 *
 * ## Matching is by physical key as well as by character
 *
 * A binding matches if *either* `event.key` or the character the physical key
 * carries on a US layout matches. Without the second, ⌥A on macOS arrives as
 * `"å"` and every align shortcut is dead; so does ⌘⇧2 as `"@"`. Modifiers are
 * matched strictly, so `R` and `⇧R` are different keys and neither leaks into
 * the other.
 *
 * ## Two things this deliberately does not own
 *
 *  - **Space-to-pan** belongs to `useViewport`, which already tracks the key,
 *    owns the cursor and reports `panState()`. It is listed here so it appears
 *    in the cheat sheet, and its handler does nothing.
 *  - **⌘C/⌘X/⌘V go through the browser's own clipboard events**, not through
 *    keydown, so `clipboardData` is available synchronously and no clipboard
 *    permission prompt is ever raised. The keydown rows exist to be displayed.
 *
 * ## The clipboard is canvas HTML
 *
 * A copy serializes the selection through the grammar and puts that text on the
 * system clipboard, so what you copied is a valid canvas document: it survives a
 * trip through any text field, and canvas HTML pasted in from anywhere else —
 * a model's reply, another canvas, a file — is parsed by the same code that
 * parses a block. The in-memory copy is only the fallback for browsers that
 * refuse to hand over `clipboardData`.
 */

import { useEffect, useRef } from "react";
import {
  absoluteRect,
  absoluteRotation,
  absoluteSelectionBounds,
  unionBounds,
} from "../scene/geometry";
import { HUG } from "../scene/autoLayout";
import { mintIds } from "../scene/ops";
import { parseScene } from "../scene/parse";
import { serializeScene } from "../scene/serialize";
import {
  findNode,
  isContainer,
  isGroup,
  nodePath,
  selectedNodes,
  walk,
  SCENE_TAG,
  TAG_BY_KIND,
  type Alignment,
  type NodeId,
  type Point,
  type Rect,
  type Scene,
  type SceneNode,
  type SceneOp,
  type StylePatch,
} from "../scene/types";
import type { SceneStore } from "./useScene";
import type { SelectionStore } from "./useSelection";
import type { ViewportController } from "./useViewport";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * The active pointer tool. `"move"` is the resting state every other tool
 * returns to; the drawing tools are named after the node kind they insert —
 * except `"diamond"`, which is the four-sided case of `"polygon"` and is a tool
 * of its own only because reaching for a diamond is not the same gesture as
 * reaching for a triangle and then counting up to four.
 */
export type CanvasTool =
  | "move"
  | "hand"
  | "rect"
  | "ellipse"
  | "polygon"
  | "diamond"
  | "text"
  | "pen";

/** The slice of tool state the keymap needs. */
export interface ToolController {
  get(): CanvasTool;
  set(tool: CanvasTool): void;
}

/**
 * Vector edit mode, which is a mode of the surface rather than a tool: the move
 * tool stays selected underneath it, so Escape has somewhere to land. `null`
 * leaves it.
 */
export interface PathEditController {
  set(id: NodeId | null): void;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export type ShortcutGroup =
  | "Tools"
  | "Edit"
  | "Arrange"
  | "Move"
  | "View"
  | "Toggle"
  | "Align";

/** Rendered in this order by a cheat sheet. */
export const SHORTCUT_GROUPS = [
  "Tools",
  "Edit",
  "Arrange",
  "Move",
  "View",
  "Toggle",
  "Align",
] as const satisfies readonly ShortcutGroup[];

export type ShortcutId =
  | "tool.move"
  | "tool.rect"
  | "tool.ellipse"
  | "tool.polygon"
  | "tool.diamond"
  | "tool.text"
  | "tool.pen"
  | "tool.hand"
  | "edit.undo"
  | "edit.redo"
  | "edit.duplicate"
  | "edit.group"
  | "edit.ungroup"
  | "edit.autoLayout"
  | "edit.delete"
  | "edit.copy"
  | "edit.cut"
  | "edit.paste"
  | "edit.pasteInPlace"
  | "edit.selectAll"
  | "edit.vector"
  | "edit.deselect"
  | "arrange.forward"
  | "arrange.backward"
  | "arrange.front"
  | "arrange.back"
  | "move.nudge"
  | "move.nudgeFar"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.zoomFit"
  | "view.zoomSelection"
  | "view.pan"
  | "toggle.hidden"
  | "toggle.locked"
  | "align.left"
  | "align.hcenter"
  | "align.right"
  | "align.top"
  | "align.vcenter"
  | "align.bottom";

export interface Shortcut {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  /**
   * Bindings that fire it, as `Mod+Alt+Shift+key`. `Mod` is ⌘ on Apple
   * platforms and Ctrl everywhere else. The first is the one the UI shows.
   */
  keys: readonly string[];
  /** Shown instead of the formatted `keys[0]` where a set of keys reads better. */
  display?: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "tool.move", label: "Move", group: "Tools", keys: ["v"] },
  { id: "tool.rect", label: "Rectangle", group: "Tools", keys: ["r"] },
  { id: "tool.ellipse", label: "Ellipse", group: "Tools", keys: ["o"] },
  { id: "tool.polygon", label: "Polygon", group: "Tools", keys: ["g"] },
  { id: "tool.diamond", label: "Diamond", group: "Tools", keys: ["d"] },
  { id: "tool.text", label: "Text", group: "Tools", keys: ["t"] },
  { id: "tool.pen", label: "Pen", group: "Tools", keys: ["p"] },
  { id: "tool.hand", label: "Hand", group: "Tools", keys: ["h"] },

  { id: "edit.undo", label: "Undo", group: "Edit", keys: ["Mod+z"] },
  {
    id: "edit.redo",
    label: "Redo",
    group: "Edit",
    keys: ["Mod+Shift+z", "Mod+y"],
  },
  { id: "edit.duplicate", label: "Duplicate", group: "Edit", keys: ["Mod+d"] },
  { id: "edit.group", label: "Group", group: "Edit", keys: ["Mod+g"] },
  { id: "edit.ungroup", label: "Ungroup", group: "Edit", keys: ["Mod+Shift+g"] },
  {
    id: "edit.autoLayout",
    label: "Add auto layout",
    group: "Edit",
    keys: ["Shift+a"],
  },
  {
    id: "edit.delete",
    label: "Delete",
    group: "Edit",
    keys: ["backspace", "delete"],
  },
  { id: "edit.copy", label: "Copy", group: "Edit", keys: ["Mod+c"] },
  { id: "edit.cut", label: "Cut", group: "Edit", keys: ["Mod+x"] },
  { id: "edit.paste", label: "Paste", group: "Edit", keys: ["Mod+v"] },
  {
    id: "edit.pasteInPlace",
    label: "Paste in place",
    group: "Edit",
    keys: ["Mod+Shift+v"],
  },
  { id: "edit.selectAll", label: "Select all", group: "Edit", keys: ["Mod+a"] },
  {
    id: "edit.vector",
    label: "Edit vector path",
    group: "Edit",
    // Only Enter is bound here. Escape leaves, but the pen overlay claims that
    // key in the capture phase before this keymap ever sees it, so it is
    // spelled out in `display` rather than bound — where a second `escape` row
    // would shadow `edit.deselect` for every other selection there is.
    keys: ["enter"],
    display: "Enter · Esc to leave",
  },
  { id: "edit.deselect", label: "Deselect / step out", group: "Edit", keys: ["escape"] },

  {
    id: "arrange.forward",
    label: "Bring forward",
    group: "Arrange",
    keys: ["Mod+]"],
  },
  {
    id: "arrange.backward",
    label: "Send backward",
    group: "Arrange",
    keys: ["Mod+["],
  },
  {
    id: "arrange.front",
    label: "Bring to front",
    group: "Arrange",
    keys: ["Mod+Alt+]"],
  },
  {
    id: "arrange.back",
    label: "Send to back",
    group: "Arrange",
    keys: ["Mod+Alt+["],
  },

  {
    id: "move.nudge",
    label: "Nudge 1px",
    group: "Move",
    keys: ["arrowleft", "arrowright", "arrowup", "arrowdown"],
    display: "← → ↑ ↓",
  },
  {
    id: "move.nudgeFar",
    label: "Nudge 10px",
    group: "Move",
    keys: [
      "Shift+arrowleft",
      "Shift+arrowright",
      "Shift+arrowup",
      "Shift+arrowdown",
    ],
    display: "⇧ ← → ↑ ↓",
  },

  {
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    keys: ["Mod+=", "Mod+Shift+="],
  },
  { id: "view.zoomOut", label: "Zoom out", group: "View", keys: ["Mod+-"] },
  {
    id: "view.zoomReset",
    label: "Zoom to 100%",
    group: "View",
    keys: ["Mod+0", "Shift+0"],
  },
  {
    id: "view.zoomFit",
    label: "Zoom to fit",
    group: "View",
    keys: ["Mod+1", "Shift+1"],
  },
  {
    id: "view.zoomSelection",
    label: "Zoom to selection",
    group: "View",
    keys: ["Mod+2", "Shift+2"],
  },
  { id: "view.pan", label: "Pan", group: "View", keys: ["space"], display: "Space (hold)" },

  {
    id: "toggle.hidden",
    label: "Show / hide",
    group: "Toggle",
    keys: ["Mod+Shift+h"],
  },
  {
    id: "toggle.locked",
    label: "Lock / unlock",
    group: "Toggle",
    keys: ["Mod+Shift+l"],
  },

  { id: "align.left", label: "Align left", group: "Align", keys: ["Alt+a"] },
  {
    id: "align.hcenter",
    label: "Align horizontal centres",
    group: "Align",
    keys: ["Alt+h"],
  },
  { id: "align.right", label: "Align right", group: "Align", keys: ["Alt+d"] },
  { id: "align.top", label: "Align top", group: "Align", keys: ["Alt+w"] },
  {
    id: "align.vcenter",
    label: "Align vertical centres",
    group: "Align",
    keys: ["Alt+v"],
  },
  { id: "align.bottom", label: "Align bottom", group: "Align", keys: ["Alt+s"] },
];

export const SHORTCUTS_BY_ID: Readonly<Record<ShortcutId, Shortcut>> =
  Object.fromEntries(SHORTCUTS.map((s) => [s.id, s])) as Record<
    ShortcutId,
    Shortcut
  >;

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

interface Binding {
  /** ⌘ on Apple platforms, Ctrl elsewhere. */
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase character, or a name: `arrowleft`, `escape`, `space`, … */
  key: string;
}

function parseBinding(spec: string): Binding {
  const parts = spec.split("+");
  // A trailing empty part is the `+` key written literally, as in "Mod++".
  const key = (parts.pop() || "+").toLowerCase();
  const binding: Binding = { mod: false, alt: false, shift: false, key };
  for (const part of parts) {
    if (part === "Mod") binding.mod = true;
    else if (part === "Alt") binding.alt = true;
    else if (part === "Shift") binding.shift = true;
  }
  return binding;
}

/**
 * The character a physical key carries on a US layout.
 *
 * This is the second half of matching: `event.key` is what the layout and the
 * modifiers produced (`"å"` for ⌥A, `"@"` for ⇧2), while `event.code` is which
 * key was struck. Matching either means a binding written as the character the
 * user sees printed on the key works under Option and under a non-US layout.
 */
function codeKey(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) {
    const rest = code.slice(6);
    if (/^\d$/.test(rest)) return rest;
    if (rest === "Add") return "=";
    if (rest === "Subtract") return "-";
    return null;
  }
  return NAMED_CODES[code] ?? null;
}

const NAMED_CODES: Readonly<Record<string, string>> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "space",
  Escape: "escape",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
};

function eventKey(e: KeyboardEvent): string {
  return e.key === " " ? "space" : e.key.toLowerCase();
}

let applePlatform: boolean | null = null;

/**
 * Whether `Mod` means ⌘. Resolved once, lazily — reading `navigator` at module
 * scope would run on the server.
 */
export function isApplePlatform(): boolean {
  applePlatform ??=
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
  return applePlatform;
}

function matches(binding: Binding, e: KeyboardEvent, apple: boolean): boolean {
  const mod = apple ? e.metaKey : e.ctrlKey;
  const spare = apple ? e.ctrlKey : e.metaKey;
  if (spare || mod !== binding.mod) return false;
  if (e.altKey !== binding.alt || e.shiftKey !== binding.shift) return false;
  return eventKey(e) === binding.key || codeKey(e.code) === binding.key;
}

const BINDINGS: readonly (Binding & { id: ShortcutId })[] = SHORTCUTS.flatMap(
  (shortcut) =>
    shortcut.keys.map((spec) => ({ ...parseBinding(spec), id: shortcut.id })),
);

function match(e: KeyboardEvent, apple: boolean): ShortcutId | null {
  for (const binding of BINDINGS) {
    if (matches(binding, e, apple)) return binding.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  "=": "+",
};

function keyGlyph(key: string, apple: boolean): string {
  if (key === "backspace") return apple ? "⌫" : "Backspace";
  if (key === "delete") return apple ? "⌦" : "Del";
  const glyph = KEY_GLYPHS[key];
  if (glyph) return glyph;
  return key.length === 1 ? key.toUpperCase() : key;
}

/** One binding as the user should read it: `⌘⇧Z`, or `Ctrl+Shift+Z`. */
export function formatShortcut(spec: string, apple = isApplePlatform()): string {
  const b = parseBinding(spec);
  const parts: string[] = [];
  if (b.mod) parts.push(apple ? "⌘" : "Ctrl");
  if (b.alt) parts.push(apple ? "⌥" : "Alt");
  if (b.shift) parts.push(apple ? "⇧" : "Shift");
  parts.push(keyGlyph(b.key, apple));
  return parts.join(apple ? "" : "+");
}

/**
 * A shortcut as a tooltip suffix — `"Duplicate ⌘D"`. Reads `navigator`, so call
 * it from an event handler or from a component that only ever renders on the
 * client (a canvas node view always does).
 */
export function shortcutHint(id: ShortcutId, apple = isApplePlatform()): string {
  const shortcut = SHORTCUTS_BY_ID[id];
  return shortcut.display ?? formatShortcut(shortcut.keys[0], apple);
}

// ---------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------

/** True while a shape's label, or any other field, has the caret. */
function isTextEntry(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The selected nodes that are live and not inside another selected node.
 *
 * A node and its ancestor both being addressed would move, duplicate or copy the
 * inner one twice; the ops layer drops them for the same reason.
 */
function topSelection(scene: Scene, ids: readonly NodeId[]): SceneNode[] {
  const wanted = new Set(ids);
  return selectedNodes(scene, ids).filter(
    (node) =>
      !nodePath(scene, node.id)
        .slice(0, -1)
        .some((ancestor) => wanted.has(ancestor.id)),
  );
}

function countNodes(nodes: readonly SceneNode[]): number {
  let n = 0;
  walk(nodes, () => {
    n++;
  });
  return n;
}

/** A deep copy with every id replaced, so it can be inserted alongside the original. */
function reid(node: SceneNode, next: () => NodeId): SceneNode {
  const id = next();
  return isContainer(node)
    ? { ...node, id, children: node.children.map((child) => reid(child, next)) }
    : { ...node, id };
}

/** Fresh copies of `nodes`, translated, with ids that collide with nothing in `scene`. */
function copiesInto(
  scene: Scene,
  nodes: readonly SceneNode[],
  dx: number,
  dy: number,
): SceneNode[] {
  const ids = mintIds(scene, countNodes(nodes));
  let i = 0;
  const next = () => ids[i++];
  return nodes.map((node) => {
    const copy = reid(node, next);
    return { ...copy, x: copy.x + dx, y: copy.y + dy };
  });
}

/**
 * Auto layout that leaves the members roughly where they already are.
 *
 * Direction is whichever axis the boxes are spread along — the axis with slack
 * between them, rather than the one where they merely overlap — and the gap is
 * that slack shared out, so turning on auto layout reads as tidying rather than
 * as collapsing everything into a stack.
 */
function autoLayoutDecls(scene: Scene, ids: readonly NodeId[]): StylePatch {
  const decls: StylePatch = { display: "flex", width: HUG, height: HUG };
  if (ids.length < 2) return decls;
  const boxes = ids.map((id) => absoluteRect(scene, id));
  const union = absoluteSelectionBounds(scene, ids);
  const slackX = union.w - boxes.reduce((n, box) => n + box.w, 0);
  const slackY = union.h - boxes.reduce((n, box) => n + box.h, 0);
  const column = slackY > slackX;
  const gap = Math.max(
    0,
    Math.round((column ? slackY : slackX) / (ids.length - 1)),
  );
  if (column) decls["flex-direction"] = "column";
  if (gap > 0) decls.gap = `${gap}px`;
  return decls;
}

/** The union of every top-level node's box, in scene space. Falls back to the surface. */
function contentBounds(scene: Scene): Rect {
  if (scene.nodes.length === 0) return { x: 0, y: 0, w: scene.w, h: scene.h };
  return absoluteSelectionBounds(
    scene,
    scene.nodes.map((node) => node.id),
  );
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

const CANVAS_TAGS = new RegExp(
  `<(${[SCENE_TAG, ...Object.values(TAG_BY_KIND)].join("|")})[\\s>]`,
  "i",
);

/** Whether some text off the system clipboard is ours to parse. */
function isCanvasHtml(text: string): boolean {
  return CANVAS_TAGS.test(text);
}

/**
 * Shared by every canvas on the page, so a copy in one block pastes into
 * another. Only ever read when the browser withheld `clipboardData`.
 */
let internalClipboard: string | null = null;

/**
 * The selection as a canvas document, flattened into scene space.
 *
 * Flattening is what makes the result meaningful anywhere: a shape copied out of
 * a group carries the position it appeared to have, so pasting it at the top
 * level, into a different group, or into a different canvas puts it where it
 * looked like it was. Its own children stay relative to it and are untouched.
 */
function clipboardHtml(scene: Scene, ids: readonly NodeId[]): string | null {
  const nodes = topSelection(scene, ids);
  if (nodes.length === 0) return null;
  const flattened = nodes.map((node) => {
    const box = absoluteRect(scene, node.id);
    return {
      ...node,
      x: box.x,
      y: box.y,
      rot: absoluteRotation(scene, node.id),
    };
  });
  return serializeScene({
    w: scene.w,
    h: scene.h,
    style: {},
    nodes: flattened,
    attrs: {},
  });
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/** How far ⌘D and a plain ⌘V offset a copy, matching Figma. */
const DUPLICATE_OFFSET = 10;

const ZOOM_STEP = 1.25;

const NUDGE: Readonly<Record<string, Point>> = {
  arrowleft: { x: -1, y: 0 },
  arrowright: { x: 1, y: 0 },
  arrowup: { x: 0, y: -1 },
  arrowdown: { x: 0, y: 1 },
};

export interface CanvasShortcutOptions {
  scene: SceneStore;
  selection: SelectionStore;
  /** Also supplies the element the listeners bind to, via `containerRef`. */
  viewport: ViewportController;
  tool: ToolController;
  /** Omitted where the surface has no vector edit mode to enter. */
  pathEdit?: PathEditController;
  /** Off for a read-only block. Default true. */
  enabled?: boolean;
}

/**
 * Binds the canvas keymap to the viewport container.
 *
 * Nothing here re-renders: the stores are read imperatively at the moment a key
 * is pressed, and the options are reached through a ref updated in an effect, so
 * the listeners are attached once for the life of the canvas.
 */
export function useCanvasShortcuts({
  enabled = true,
  ...stores
}: CanvasShortcutOptions): void {
  const latest = useRef(stores);
  // Written in an effect, never during render: this ref is read by listeners,
  // and a render that React discards must not be the one they see.
  useEffect(() => {
    latest.current = stores;
  });

  const container = stores.viewport.containerRef;

  useEffect(() => {
    const el = container.current;
    if (!el || !enabled) return;

    const apple = isApplePlatform();
    /** Set by the ⌘⇧V keydown and consumed by the paste event it produces. */
    let pasteInPlace = false;

    // -- Reading ------------------------------------------------------------

    const scene = () => latest.current.scene.getScene();

    /** The addressable selection: live, top-most, in document order. */
    const targets = () =>
      topSelection(scene(), latest.current.selection.getSnapshot().ids);

    const targetIds = () => targets().map((node) => node.id);

    /** The innermost group we are inside that still exists — where a paste lands. */
    const level = (): NodeId | null => {
      const current = scene();
      const path = latest.current.selection.getSnapshot().enteredPath;
      for (let i = path.length - 1; i >= 0; i--) {
        const node = findNode(current, path[i]);
        if (node && isContainer(node)) return node.id;
      }
      return null;
    };

    const viewportCentre = (): Point | null => {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return null;
      return latest.current.viewport.clientToScene({
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      });
    };

    // -- Writing ------------------------------------------------------------

    const dispatch = (ops: SceneOp | SceneOp[]) =>
      latest.current.scene.dispatch(ops);

    const insert = (nodes: SceneNode[], parentId: NodeId | null) => {
      if (nodes.length === 0) return;
      dispatch({ type: "insert", nodes, parentId });
      latest.current.selection.select(nodes.map((node) => node.id));
    };

    /** Paste canvas HTML at `offset` from where it was copied. */
    const paste = (html: string, inPlace: boolean): void => {
      const fragment = parseScene(html);
      if (fragment.nodes.length === 0) return;

      const current = scene();
      const parentId = level();
      // The clipboard is in scene space; a group's children are in its own.
      const origin = parentId
        ? absoluteRect(current, parentId)
        : { x: 0, y: 0, w: 0, h: 0 };

      let dx = -origin.x;
      let dy = -origin.y;
      if (!inPlace) {
        // Centre the paste on what the user is looking at, as Figma does when
        // the copy did not come from the visible area.
        const box = unionBounds(fragment.nodes);
        const view = viewportCentre();
        if (view) {
          dx += view.x - (box.x + box.w / 2);
          dy += view.y - (box.y + box.h / 2);
        } else {
          dx += DUPLICATE_OFFSET;
          dy += DUPLICATE_OFFSET;
        }
      }
      insert(copiesInto(current, fragment.nodes, dx, dy), parentId);
    };

    const zoomTo = (bounds: Rect) => {
      if (bounds.w > 0 && bounds.h > 0) {
        latest.current.viewport.zoomToFit(bounds);
      }
    };

    // -- Commands -----------------------------------------------------------

    const setTool = (tool: CanvasTool) => {
      latest.current.tool.set(tool);
      return true;
    };

    const nudge = (e: KeyboardEvent, step: number): boolean => {
      const delta =
        NUDGE[eventKey(e)] ?? NUDGE[codeKey(e.code) ?? ""] ?? null;
      const ids = targetIds();
      if (!delta || ids.length === 0) return false;
      dispatch({ type: "move", ids, dx: delta.x * step, dy: delta.y * step });
      return true;
    };

    const align = (to: Alignment): boolean => {
      const ids = targetIds();
      if (ids.length === 0) return false;
      dispatch({ type: "align", ids, to });
      return true;
    };

    /**
     * ⌘⇧L and ⌘⇧H, over the whole selection at once: all of it already carries
     * the flag, so it comes off; otherwise it goes on — the same reading the
     * context menu shows as "Unlock" or "Lock".
     *
     * Always consumes the key, even with nothing selected. ⌘⇧H is Chrome's
     * "Home", so a canvas shortcut that declines it navigates the window away
     * from the document — the one outcome worse than doing nothing.
     */
    const toggleFlag = (flag: "locked" | "hidden"): boolean => {
      const nodes = targets();
      if (nodes.length === 0) return true;
      const value = !nodes.every((node) => node[flag]);
      const ids = nodes.map((node) => node.id);
      dispatch(
        flag === "locked"
          ? { type: "setLocked", ids, locked: value }
          : { type: "setHidden", ids, hidden: value },
      );
      return true;
    };

    const reorder = (at: "front" | "back" | "forward" | "backward"): boolean => {
      const ids = targetIds();
      if (ids.length === 0) return false;
      dispatch({ type: "reorder", ids, to: { at } });
      return true;
    };

    const commands: Record<ShortcutId, (e: KeyboardEvent) => boolean> = {
      "tool.move": () => setTool("move"),
      "tool.rect": () => setTool("rect"),
      "tool.ellipse": () => setTool("ellipse"),
      "tool.polygon": () => setTool("polygon"),
      "tool.diamond": () => setTool("diamond"),
      "tool.text": () => setTool("text"),
      "tool.pen": () => setTool("pen"),
      "tool.hand": () => setTool("hand"),

      "edit.undo": () => {
        latest.current.scene.undo();
        return true;
      },
      "edit.redo": () => {
        latest.current.scene.redo();
        return true;
      },

      "edit.duplicate": () => {
        const current = scene();
        const nodes = topSelection(
          current,
          latest.current.selection.getSnapshot().ids,
        );
        if (nodes.length === 0) return true;
        // Copies land frontmost within the parent they came from: in front of
        // the original, which is both Figma's placement and the only one that
        // guarantees you can see what you just made.
        const copies = copiesInto(
          current,
          nodes,
          DUPLICATE_OFFSET,
          DUPLICATE_OFFSET,
        );
        const parents = new Map<NodeId | null, SceneNode[]>();
        nodes.forEach((node, i) => {
          const parent = parentIdOf(current, node.id);
          const list = parents.get(parent);
          if (list) list.push(copies[i]);
          else parents.set(parent, [copies[i]]);
        });
        dispatch(
          [...parents].map(([parentId, group]) => ({
            type: "insert" as const,
            nodes: group,
            parentId,
          })),
        );
        latest.current.selection.select(copies.map((node) => node.id));
        return true;
      },

      "edit.group": () => {
        const current = scene();
        const ids = topSelection(
          current,
          latest.current.selection.getSnapshot().ids,
        ).map((node) => node.id);
        if (ids.length === 0) return true;
        const groupId = mintIds(current, 1)[0];
        dispatch({ type: "group", ids, groupId });
        latest.current.selection.select([groupId]);
        return true;
      },

      // Figma's ⇧A: group and lay out in one move. A lone group takes the
      // layout itself — wrapping a group in a group to lay out its one child
      // is not what anyone means by it.
      "edit.autoLayout": () => {
        const current = scene();
        const nodes = topSelection(
          current,
          latest.current.selection.getSnapshot().ids,
        );
        if (nodes.length === 0) return true;
        if (nodes.length === 1 && isGroup(nodes[0])) {
          const group = nodes[0];
          dispatch({
            type: "setStyle",
            ids: [group.id],
            decls: autoLayoutDecls(
              current,
              group.children.map((child) => child.id),
            ),
          });
          return true;
        }
        const ids = nodes.map((node) => node.id);
        const groupId = mintIds(current, 1)[0];
        dispatch([
          { type: "group", ids, groupId },
          { type: "setStyle", ids: [groupId], decls: autoLayoutDecls(current, ids) },
        ]);
        latest.current.selection.select([groupId]);
        return true;
      },

      "edit.ungroup": () => {
        const groups = targets().filter(isGroup);
        if (groups.length === 0) return true;
        const children = groups.flatMap((group) =>
          group.children.map((child) => child.id),
        );
        dispatch({ type: "ungroup", ids: groups.map((group) => group.id) });
        latest.current.selection.select(children);
        return true;
      },

      "edit.delete": () => {
        const ids = targetIds();
        // Nothing selected: let the editor have the key, so ⌫ still removes the
        // block the canvas is sitting in.
        if (ids.length === 0) return false;
        dispatch({ type: "remove", ids });
        latest.current.selection.clear();
        return true;
      },

      // ⌘C/⌘X/⌘V are handled by the clipboard events the browser raises from
      // these keys, where `clipboardData` is available without a permission
      // prompt. Letting the key through is what produces those events.
      "edit.copy": () => false,
      "edit.cut": () => false,
      "edit.paste": () => {
        pasteInPlace = false;
        return false;
      },
      "edit.pasteInPlace": () => {
        pasteInPlace = true;
        return false;
      },

      "edit.selectAll": () => {
        latest.current.selection.selectAll();
        return true;
      },

      // Figma's Enter: open the selected vector for point editing. Anything
      // else keeps the key, so Enter still belongs to the document around us.
      "edit.vector": () => {
        const pathEdit = latest.current.pathEdit;
        const ids = targetIds();
        if (!pathEdit || ids.length !== 1) return false;
        const node = findNode(scene(), ids[0]);
        if (node?.kind !== "path") return false;
        pathEdit.set(node.id);
        return true;
      },

      "edit.deselect": () => {
        if (latest.current.tool.get() !== "move") {
          latest.current.tool.set("move");
          return true;
        }
        const before = latest.current.selection.getSnapshot();
        latest.current.selection.escape();
        // Escape with nothing to leave belongs to whoever is around us — it is
        // how the user gets out of the canvas and back to the document.
        return (
          before.ids.length > 0 ||
          before.enteredPath.length > 0
        );
      },

      "arrange.forward": () => reorder("forward"),
      "arrange.backward": () => reorder("backward"),
      "arrange.front": () => reorder("front"),
      "arrange.back": () => reorder("back"),

      "move.nudge": (e) => nudge(e, 1),
      "move.nudgeFar": (e) => nudge(e, 10),

      "view.zoomIn": () => {
        latest.current.viewport.zoomBy(ZOOM_STEP);
        return true;
      },
      "view.zoomOut": () => {
        latest.current.viewport.zoomBy(1 / ZOOM_STEP);
        return true;
      },
      "view.zoomReset": () => {
        latest.current.viewport.resetZoom();
        return true;
      },
      "view.zoomFit": () => {
        zoomTo(contentBounds(scene()));
        return true;
      },
      "view.zoomSelection": () => {
        const ids = targetIds();
        const current = scene();
        zoomTo(
          ids.length
            ? absoluteSelectionBounds(current, ids)
            : contentBounds(current),
        );
        return true;
      },
      // Space-to-pan is the viewport's: it tracks the key, owns the cursor and
      // reports `panState()`. Listed only so it appears in the cheat sheet.
      "view.pan": () => false,

      "toggle.hidden": () => toggleFlag("hidden"),
      "toggle.locked": () => toggleFlag("locked"),

      "align.left": () => align("left"),
      "align.hcenter": () => align("hcenter"),
      "align.right": () => align("right"),
      "align.top": () => align("top"),
      "align.vcenter": () => align("vcenter"),
      "align.bottom": () => align("bottom"),
    };

    // -- Listeners ----------------------------------------------------------

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || isTextEntry()) return;
      const id = match(e, apple);
      if (!id || !commands[id](e)) return;
      e.preventDefault();
      // The canvas is inside a ProseMirror document that wants these same keys.
      e.stopPropagation();
    };

    /**
     * Clipboard events are listened for on the document in the capture phase,
     * not on the canvas: the browser aims them at whatever holds the selection,
     * which is not always the focused element, and capturing at the top is the
     * only place we are certain to run before the editor's own handlers.
     */
    const isActive = () => el.contains(document.activeElement) && !isTextEntry();

    const onCopy = (e: ClipboardEvent) => {
      if (!isActive()) return;
      const html = clipboardHtml(
        scene(),
        latest.current.selection.getSnapshot().ids,
      );
      if (!html) return;
      internalClipboard = html;
      e.clipboardData?.setData("text/plain", html);
      e.preventDefault();
      e.stopPropagation();
    };

    const onCut = (e: ClipboardEvent) => {
      if (!isActive()) return;
      const ids = targetIds();
      onCopy(e);
      if (e.defaultPrevented && ids.length > 0) {
        dispatch({ type: "remove", ids });
        latest.current.selection.clear();
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!isActive()) return;
      // Consumed either way: a paste aimed at the canvas must never fall
      // through and drop the clipboard into the document behind it.
      e.preventDefault();
      e.stopPropagation();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const html = isCanvasHtml(text) ? text : internalClipboard;
      const inPlace = pasteInPlace;
      pasteInPlace = false;
      if (html) paste(html, inPlace);
    };

    el.addEventListener("keydown", onKeyDown);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCut, true);
    document.addEventListener("paste", onPaste, true);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
      document.removeEventListener("paste", onPaste, true);
    };
    // `latest` carries the stores; only the element and the enabled flag decide
    // whether the listeners exist at all.
  }, [container, enabled]);
}

/** The id of the group holding `id`, or `null` at the top level. */
function parentIdOf(scene: Scene, id: NodeId): NodeId | null {
  const path = nodePath(scene, id);
  return path.length > 1 ? path[path.length - 2].id : null;
}
