"use client";

/**
 * The canvas keymap — Figma's, scoped to the canvas.
 *
 * ## Scoping is the whole problem
 *
 * A diagram is a node view inside a ProseMirror document, so every key it
 * wants is a key the editor also wants: ⌘Z, ⌘A, ⌘C, ⌫, the arrows. On the page
 * one listener per pane speaks for all of its diagrams (`page/pageKeymap.ts`),
 * in the capture phase ahead of the editor; a surface standing on its own — a
 * storyboard's shot, a harness — binds the same verbs to its own container
 * here. Either way a handled key is `stopPropagation`'d so the editor's keymap
 * never sees it, and nothing fires while a shape's label or any other field
 * has the caret.
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
 *  - **Space and the zoom keys** move the page, not a diagram — a diagram has
 *    no view of its own to move. They are listed here so they appear in the
 *    cheat sheet, and their handlers decline.
 *  - **⌘C/⌘X/⌘V go through the browser's own clipboard events**, not through
 *    keydown, so `clipboardData` is available synchronously and no clipboard
 *    permission prompt is ever raised. The keydown rows exist to be displayed.
 *
 * The clipboard's own format and helpers live in `./clipboard`.
 */

import { useEffect, useRef } from "react";
import { isApplePlatform, isModKey } from "@/app/lib/platform";

export { isApplePlatform, isModKey };
import {
  absoluteBounds,
  absoluteRect,
  absoluteSelectionBounds,
  unionBounds,
} from "../scene/geometry";
import { HUG } from "../scene/autoLayout";
import { booleanOps, flattenOps, loadClipper } from "../scene/boolean";
import { mintEdgeIds, mintIds } from "../scene/ops";
import { parseScene } from "../scene/parse";
import {
  findNode,
  hasText,
  isContainer,
  isGroup,
  nodePath,
  topSelection,
  type Alignment,
  type NodeId,
  type Point,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type SceneOp,
  type StylePatch,
  isBoolean,
  type BooleanOp,
} from "../scene/types";
import { clipboardHtml, copiesInto, isCanvasHtml, lastCopy, rememberCopy } from "./clipboard";
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
 *
 * `"scale"` is `"move"` with the handles rebound — same selecting, same
 * dragging, but a handle multiplies the selection instead of restating its box.
 */
export type CanvasTool =
  | "move"
  | "scale"
  | "hand"
  | "rect"
  | "ellipse"
  | "polygon"
  | "diamond"
  | "text"
  | "pen"
  | "connector";

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
  | "Select"
  | "Arrange"
  | "Move"
  | "View"
  | "Toggle"
  | "Align";

/** Rendered in this order by a cheat sheet. */
export const SHORTCUT_GROUPS = [
  "Tools",
  "Edit",
  "Select",
  "Arrange",
  "Move",
  "View",
  "Toggle",
  "Align",
] as const satisfies readonly ShortcutGroup[];

export type ShortcutId =
  | "tool.move"
  | "tool.scale"
  | "tool.rect"
  | "tool.ellipse"
  | "tool.polygon"
  | "tool.diamond"
  | "tool.text"
  | "tool.pen"
  | "tool.connector"
  | "tool.hand"
  | "edit.undo"
  | "edit.redo"
  | "edit.duplicate"
  | "edit.group"
  | "edit.ungroup"
  | "edit.autoLayout"
  | "edit.union"
  | "edit.subtract"
  | "edit.intersect"
  | "edit.exclude"
  | "edit.flatten"
  | "edit.delete"
  | "edit.copy"
  | "edit.cut"
  | "edit.paste"
  | "edit.pasteInPlace"
  | "edit.copyHtml"
  | "edit.copyJsx"
  | "edit.selectAll"
  | "edit.vector"
  | "edit.deselect"
  | "select.parent"
  | "select.next"
  | "select.previous"
  | "select.deep"
  | "select.layers"
  | "select.through"
  | "arrange.forward"
  | "arrange.backward"
  | "arrange.front"
  | "arrange.back"
  | "move.nudge"
  | "move.nudgeFar"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
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
  /**
   * Shown instead of the formatted `keys[0]` where a set of keys reads
   * better. A function is resolved with `isApplePlatform()` — for a
   * display-only row (`keys: []`) whose hint names the platform's modifier
   * glyph, such as ⌘-click.
   */
  display?: string | ((apple: boolean) => string);
  /**
   * Bindings on non-Apple platforms when they differ from `keys` — a `Ctrl`
   * token in `keys` is the spare modifier on Apple (⌃) and has no off-Apple
   * meaning, so a row that needs one supplies the real off-Apple key here.
   */
  other?: readonly string[];
}

/** ⌘ on Apple, `Ctrl+` everywhere else — the prefix for a display-only pointer
 *  hint (`select.deep`/`select.layers`/`select.through`); the trailing space
 *  differs because ⌘ reads as a standalone glyph and `Ctrl+` doesn't. */
function modGlyph(apple: boolean): string {
  return apple ? "⌘ " : "Ctrl+";
}

function modHint(apple: boolean, word: string): string {
  return `${modGlyph(apple)}${word}`;
}

/**
 * The tools answer to ⌥⇧ and a letter (Alt+Shift elsewhere) anywhere, and to
 * the bare letter inside a diagram that has the keyboard. The bar is always
 * there now, over a page you are typing in, where a bare R is a letter, not a
 * rectangle — so the page listens for ⌥⇧ only. ⌥ alone is taken by the
 * alignments, ⌘ by the browser's own (⌘R, ⌘T), and ⌃ on a Mac by the text
 * fields' line editing; ⌥⇧ is free on both platforms and in the editor.
 */
const tool = (letter: string) => [`Alt+Shift+${letter}`, letter];

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "tool.move", label: "Move", group: "Tools", keys: tool("v") },
  { id: "tool.scale", label: "Scale", group: "Tools", keys: tool("k") },
  { id: "tool.rect", label: "Rectangle", group: "Tools", keys: tool("r") },
  { id: "tool.ellipse", label: "Ellipse", group: "Tools", keys: tool("o") },
  { id: "tool.polygon", label: "Polygon", group: "Tools", keys: tool("g") },
  { id: "tool.diamond", label: "Diamond", group: "Tools", keys: tool("d") },
  { id: "tool.text", label: "Text", group: "Tools", keys: tool("t") },
  { id: "tool.pen", label: "Pen", group: "Tools", keys: tool("p") },
  { id: "tool.connector", label: "Connector", group: "Tools", keys: tool("c") },
  { id: "tool.hand", label: "Hand", group: "Tools", keys: tool("h") },

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
  // Figma's boolean bindings, and its ⌘E for flatten.
  { id: "edit.union", label: "Union", group: "Edit", keys: ["Mod+Alt+u"] },
  { id: "edit.subtract", label: "Subtract", group: "Edit", keys: ["Mod+Alt+s"] },
  { id: "edit.intersect", label: "Intersect", group: "Edit", keys: ["Mod+Alt+i"] },
  { id: "edit.exclude", label: "Exclude", group: "Edit", keys: ["Mod+Alt+x"] },
  { id: "edit.flatten", label: "Flatten", group: "Edit", keys: ["Mod+e"] },
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
  // Menu-only (COMPILE): a fragment as standard HTML/CSS or JSX, for pasting
  // outside Nootles. No default key binding — `display: ""` keeps
  // `shortcutHint` from reading `keys[0]`, which is empty on purpose.
  { id: "edit.copyHtml", label: "Copy as HTML", group: "Edit", keys: [], display: "" },
  { id: "edit.copyJsx", label: "Copy as React", group: "Edit", keys: [], display: "" },
  { id: "edit.selectAll", label: "Select all", group: "Edit", keys: ["Mod+a"] },
  {
    id: "edit.vector",
    label: "Enter group / edit",
    group: "Select",
    // Only Enter is bound here. Escape leaves, but the pen overlay claims that
    // key in the capture phase before this keymap ever sees it, so it is
    // spelled out in `display` rather than bound — where a second `escape` row
    // would shadow `edit.deselect` for every other selection there is.
    keys: ["enter"],
    display: "Enter",
  },
  { id: "edit.deselect", label: "Deselect / step out", group: "Edit", keys: ["escape"] },

  { id: "select.parent", label: "Select parent", group: "Select", keys: ["Shift+enter"] },
  { id: "select.next", label: "Select next sibling", group: "Select", keys: ["tab"] },
  {
    id: "select.previous",
    label: "Select previous sibling",
    group: "Select",
    keys: ["Shift+tab"],
  },
  // Display-only: `keys: []` binds nothing (a pointer gesture, not a key),
  // so `shortcutHint` must read `display` — never `formatShortcut(keys[0])`,
  // which is unreachable here on purpose.
  {
    id: "select.deep",
    label: "Select deepest (click)",
    group: "Select",
    keys: [],
    display: (apple) => modHint(apple, "click"),
  },
  {
    id: "select.layers",
    label: "Select layer…",
    group: "Select",
    keys: [],
    display: (apple) => modHint(apple, "right-click"),
  },
  {
    id: "select.through",
    label: "Marquee through frame",
    group: "Select",
    keys: [],
    display: (apple) => modHint(apple, "drag"),
  },

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
  // Not `Shift+0` as well: on the page that types a ")".
  { id: "view.zoomReset", label: "Zoom to 100%", group: "View", keys: ["Mod+0"] },
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
  /** The modifier that is NOT `mod` on this platform — ⌃ on Apple. Off-Apple
   *  this would be the OS key, so a row needing it supplies `other` instead
   *  of ever setting this from a real off-Apple binding. */
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase character, or a name: `arrowleft`, `escape`, `space`, … */
  key: string;
}

function parseBinding(spec: string): Binding {
  const parts = spec.split("+");
  // A trailing empty part is the `+` key written literally, as in "Mod++".
  const key = (parts.pop() || "+").toLowerCase();
  const binding: Binding = { mod: false, ctrl: false, alt: false, shift: false, key };
  for (const part of parts) {
    if (part === "Mod") binding.mod = true;
    else if (part === "Ctrl") binding.ctrl = true;
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


function matches(binding: Binding, e: KeyboardEvent, apple: boolean): boolean {
  const mod = apple ? e.metaKey : e.ctrlKey;
  const spare = apple ? e.ctrlKey : e.metaKey;
  if (mod !== binding.mod || spare !== binding.ctrl) return false;
  if (e.altKey !== binding.alt || e.shiftKey !== binding.shift) return false;
  return eventKey(e) === binding.key || codeKey(e.code) === binding.key;
}

/** `keys` on Apple, `other ?? keys` everywhere else — the one place that
 *  decides which of a row's two binding lists is live on this platform. */
function specsFor(shortcut: Shortcut, apple: boolean): readonly string[] {
  return apple ? shortcut.keys : (shortcut.other ?? shortcut.keys);
}

const bindingsCache = new Map<boolean, readonly (Binding & { id: ShortcutId })[]>();

/** Memoised per platform: `isApplePlatform()` never changes within a session,
 *  so this is computed at most twice for the life of the page. */
function bindingsFor(apple: boolean): readonly (Binding & { id: ShortcutId })[] {
  let cached = bindingsCache.get(apple);
  if (!cached) {
    cached = SHORTCUTS.flatMap((shortcut) =>
      specsFor(shortcut, apple).map((spec) => ({
        ...parseBinding(spec),
        id: shortcut.id,
      })),
    );
    bindingsCache.set(apple, cached);
  }
  return cached;
}

/** The shortcut a keydown fires, if any — on `apple`'s binding table. */
export function matchShortcut(e: KeyboardEvent, apple: boolean): ShortcutId | null {
  for (const binding of bindingsFor(apple)) {
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
  f11: "F11",
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
  if (b.ctrl) parts.push(apple ? "⌃" : "Ctrl");
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
/** `nth` picks among a shortcut's bindings — a tool's bare letter is its second. */
export function shortcutHint(id: ShortcutId, apple = isApplePlatform(), nth = 0): string {
  const shortcut = SHORTCUTS_BY_ID[id];
  const d = typeof shortcut.display === "function" ? shortcut.display(apple) : shortcut.display;
  if (d !== undefined) return d;
  const specs = specsFor(shortcut, apple);
  const spec = specs[nth] ?? specs[0];
  return spec ? formatShortcut(spec, apple) : "";
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
 * Whether a tool's key picks it on the page (a shot's own keymap takes every
 * letter). ⌥⇧ and the letter always do; the bare letter
 * only over shapes in hand with no caret in the page, where a letter is not
 * typing — and not in a band that holds nothing either, whose letters the
 * person may well think are going to the text beside it.
 */
export function toolKeyAllowed(key: {
  chord: boolean;
  field: boolean;
  page: boolean;
  shapes: boolean;
}): boolean {
  if (key.field) return false;
  return key.chord || (key.shapes && !key.page);
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

/** The id of the group holding `id`, or `null` at the top level. */
function parentIdOf(scene: Scene, id: NodeId): NodeId | null {
  const path = nodePath(scene, id);
  return path.length > 1 ? path[path.length - 2].id : null;
}

/** The innermost entered group that still exists — where a paste lands. */
export function pasteLevel(scene: Scene, selection: SelectionStore): NodeId | null {
  const path = selection.getSnapshot().enteredPath;
  for (let i = path.length - 1; i >= 0; i--) {
    const node = findNode(scene, path[i]);
    if (node && isContainer(node)) return node.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** How far ⌘D and a plain ⌘V offset a copy, matching Figma. */
export const DUPLICATE_OFFSET = 10;

const NUDGE: Readonly<Record<string, Point>> = {
  arrowleft: { x: -1, y: 0 },
  arrowright: { x: 1, y: 0 },
  arrowup: { x: 0, y: -1 },
  arrowdown: { x: 0, y: 1 },
};

/** Which way an arrow key moves the selection, by character or by physical key. */
export function nudgeDelta(e: KeyboardEvent): Point | null {
  return NUDGE[eventKey(e)] ?? NUDGE[codeKey(e.code) ?? ""] ?? null;
}

/**
 * How long a run of nudges survives with no further arrow key. Longer than the
 * delay an OS waits before a held key starts repeating, so holding one arrow
 * stays a single run; in the ordinary case the key coming up ends it sooner.
 */
const NUDGE_RUN_MS = 600;

/** Where a band lets its content go across; a frame holds nothing in. */
export type NudgeRange = { minX: number; maxX: number };

/**
 * A run of nudges bracketed into one undo entry.
 *
 * The bracket is not about nudging, it is about key repeat: holding an arrow
 * has the OS deliver a keydown every few tens of milliseconds, and outside a
 * bracket every dispatch is an entry of its own, so two seconds of ⇧→ would
 * spend most of the store's bounded history and take as many ⌘Zs to walk
 * back. Direction and step may change freely within the run.
 *
 * The run ends at the key coming up, at {@link NUDGE_RUN_MS} of quiet, at any
 * other command, at the selection moving elsewhere, and before an undo steps —
 * so nothing that is not part of the same arrow-keying is folded in. Each of
 * those calls `settle`, which is the run's own end unless a caller holding
 * several runs — one per diagram — ends them together.
 */
export interface NudgeRun {
  /** Moves `ids` by the step, opening the bracket if it is not open. */
  move(ids: NodeId[], dx: number, dy: number): void;
  end(): void;
  /** Ends the run and stops listening. */
  dispose(): void;
}

export function createNudgeRun(
  store: SceneStore,
  selection: SelectionStore,
  settle?: () => void,
): NudgeRun {
  let idle: ReturnType<typeof setTimeout> | null = null;
  /**
   * The selection the open run started under, held by identity — which the
   * selection store makes meaningful: it threads the same `ids` array through
   * a hover change, so pointing at a shape mid-run is not mistaken for the
   * selection moving on.
   */
  let held: readonly NodeId[] = [];
  const end = () => {
    if (idle === null) return;
    clearTimeout(idle);
    idle = null;
    store.commit();
  };
  const done = () => (settle ?? end)();
  const offSelection = selection.subscribe(() => {
    if (idle !== null && selection.getSnapshot().ids !== held) done();
  });
  // Undo settles an idle-held run before it walks, so ⌘Z mid-run takes the
  // whole run back rather than being refused.
  const offStep = store.onBeforeStep(() => {
    if (idle !== null) done();
  });
  return {
    move: (ids, dx, dy) => {
      if (idle === null) {
        held = selection.getSnapshot().ids;
        store.begin();
      } else {
        clearTimeout(idle);
      }
      idle = setTimeout(done, NUDGE_RUN_MS);
      if (dx || dy) store.dispatch({ type: "move", ids, dx, dy });
    },
    end,
    dispose: () => {
      end();
      offSelection();
      offStep();
    },
  };
}

/**
 * A step held inside the band: never above its top, never off its sides — and
 * content already past an edge is not pushed further out.
 */
function clampNudge(
  scene: Scene,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
  range: NudgeRange | null,
): Point {
  if (!range || ids.length === 0) return { x: dx, y: dy };
  const box = unionBounds(ids.map((id) => ({ ...absoluteBounds(scene, id), rot: 0 })));
  const x =
    dx > 0
      ? Math.min(dx, Math.max(0, range.maxX - (box.x + box.w)))
      : Math.max(dx, Math.min(0, range.minX - box.x));
  const y = dy < 0 ? Math.max(dy, Math.min(0, -box.y)) : dy;
  return { x, y };
}

export interface DiagramCommandContext {
  store: SceneStore;
  selection: SelectionStore;
  nudge: NudgeRun;
  /** Where a nudge may take the selection; `null` for a frame. */
  band(): NudgeRange | null;
  /** The tool, for the tool keys and Escape — a surface keeping its own. */
  tool?: ToolController;
  /** Omitted where the surface has no vector edit mode to enter. */
  pathEdit?: PathEditController;
  /** Opens a shape's label for editing — Enter on a text-bearing node. */
  labelEdit?: { open(id: NodeId): void };
  /**
   * ⌘⇧H and ⌘⇧L: the value to write. The page reads it over its whole
   * selection, so shapes in two diagrams lock or unlock together.
   */
  flag?(flag: "locked" | "hidden"): boolean;
}

/**
 * The keymap's verbs over one diagram: the selection read and the ops written
 * through the stores it is handed, at the moment a key is pressed. `true`
 * when the key was the diagram's to take.
 */
export function createDiagramCommands(
  ctx: DiagramCommandContext,
): Record<ShortcutId, (e: KeyboardEvent) => boolean> {
  const { store, selection } = ctx;
  const scene = () => store.getScene();
  const dispatch = (ops: SceneOp | SceneOp[]) => store.dispatch(ops);

  /** The addressable selection: live, top-most, in document order. */
  const targets = () => topSelection(scene(), selection.getSnapshot().ids);
  const targetIds = () => targets().map((node) => node.id);

  const boolean = (op: BooleanOp) => {
    const result = booleanOps(scene(), targets(), op);
    if (!result) return true;
    dispatch(result.ops);
    selection.select(result.select);
    return true;
  };

  const setTool = (tool: CanvasTool) => {
    if (!ctx.tool) return false;
    ctx.tool.set(tool);
    return true;
  };

  const nudge = (e: KeyboardEvent, step: number): boolean => {
    const delta = nudgeDelta(e);
    const ids = targetIds();
    if (!delta || ids.length === 0) return false;
    const { x, y } = clampNudge(scene(), ids, delta.x * step, delta.y * step, ctx.band());
    ctx.nudge.move(ids, x, y);
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
    const value = ctx.flag ? ctx.flag(flag) : !nodes.every((node) => node[flag]);
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

  return {
    "tool.move": () => setTool("move"),
    "tool.scale": () => setTool("scale"),
    "tool.rect": () => setTool("rect"),
    "tool.ellipse": () => setTool("ellipse"),
    "tool.polygon": () => setTool("polygon"),
    "tool.diamond": () => setTool("diamond"),
    "tool.text": () => setTool("text"),
    "tool.pen": () => setTool("pen"),
    "tool.connector": () => setTool("connector"),
    "tool.hand": () => setTool("hand"),

    "edit.undo": () => {
      store.undo();
      return true;
    },
    "edit.redo": () => {
      store.redo();
      return true;
    },

    "edit.duplicate": () => {
      const current = scene();
      const nodes = topSelection(current, selection.getSnapshot().ids);
      if (nodes.length === 0) return true;
      // Copies land frontmost within the parent they came from: in front of
      // the original, which is both Figma's placement and the only one that
      // guarantees you can see what you just made.
      const copies = copiesInto(current, nodes, DUPLICATE_OFFSET, DUPLICATE_OFFSET);
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
      selection.select(copies.map((node) => node.id));
      return true;
    },

    "edit.group": () => {
      const current = scene();
      const ids = topSelection(current, selection.getSnapshot().ids).map((node) => node.id);
      if (ids.length === 0) return true;
      const groupId = mintIds(current, 1)[0];
      dispatch({ type: "group", ids, groupId });
      selection.select([groupId]);
      return true;
    },

    // Figma's ⇧A: group and lay out in one move. A lone group takes the
    // layout itself — wrapping a group in a group to lay out its one child
    // is not what anyone means by it.
    "edit.autoLayout": () => {
      const current = scene();
      const nodes = topSelection(current, selection.getSnapshot().ids);
      if (nodes.length === 0) return true;
      if (nodes.length === 1 && isGroup(nodes[0])) {
        const group = nodes[0];
        dispatch({
          type: "setStyle",
          ids: [group.id],
          decls: autoLayoutDecls(current, group.children.map((child) => child.id)),
        });
        return true;
      }
      const ids = nodes.map((node) => node.id);
      const groupId = mintIds(current, 1)[0];
      dispatch([
        { type: "group", ids, groupId },
        { type: "setStyle", ids: [groupId], decls: autoLayoutDecls(current, ids) },
      ]);
      selection.select([groupId]);
      return true;
    },

    "edit.union": () => boolean("union"),
    "edit.subtract": () => boolean("subtract"),
    "edit.intersect": () => boolean("intersect"),
    "edit.exclude": () => boolean("exclude"),

    // The clipper may still be loading on a page whose first boolean this
    // is; the flatten waits for it and reads the scene again when it lands.
    "edit.flatten": () => {
      const ids = targets().filter(isBoolean).map((node) => node.id);
      if (ids.length === 0) return true;
      void loadClipper().then(() => {
        const ops = flattenOps(scene(), ids);
        if (ops.length) dispatch(ops);
      });
      return true;
    },

    "edit.ungroup": () => {
      const groups = targets().filter(isGroup);
      if (groups.length === 0) return true;
      const children = groups.flatMap((group) => group.children.map((child) => child.id));
      dispatch({ type: "ungroup", ids: groups.map((group) => group.id) });
      selection.select(children);
      return true;
    },

    "edit.delete": () => {
      // Connectors first: the two selections are mutually exclusive, so at
      // most one of these is non-empty.
      const edgeIds = selection.getSnapshot().edgeIds;
      if (edgeIds.length > 0) {
        dispatch({ type: "removeEdge", ids: [...edgeIds] });
        selection.clear();
        return true;
      }
      const ids = targetIds();
      if (ids.length === 0) return false;
      dispatch({ type: "remove", ids });
      selection.clear();
      return true;
    },

    // ⌘C/⌘X/⌘V are handled by the clipboard events the browser raises from
    // these keys, where `clipboardData` is available without a permission
    // prompt. Letting the key through is what produces those events.
    "edit.copy": () => false,
    "edit.cut": () => false,
    "edit.paste": () => false,
    "edit.pasteInPlace": () => false,

    // Menu-only, no keyboard binding — see the table row's own comment.
    "edit.copyHtml": () => false,
    "edit.copyJsx": () => false,

    "edit.selectAll": () => {
      selection.selectAll();
      return true;
    },

    // Figma's Enter, resolved by kind rather than a single hardcoded
    // action: a group (incl. boolean) steps in and selects its first
    // child, a path opens for vector editing, a text-bearing leaf opens
    // its label, an image is a consumed no-op. Anything selected (or only
    // an edge selected) claims the key so it can never leak Enter to the
    // document under a selected shape.
    "edit.vector": () => {
      const snapshot = selection.getSnapshot();
      const ids = targetIds();
      if (ids.length === 0) return snapshot.edgeIds.length > 0;
      if (ids.length !== 1) return true;
      const node = findNode(scene(), ids[0]);
      if (!node || node.locked) return true;
      if (isContainer(node)) {
        selection.enterSelected();
        return true;
      }
      if (node.kind === "path") {
        ctx.pathEdit?.set(node.id);
        return true;
      }
      if (hasText(node)) {
        ctx.labelEdit?.open(node.id);
        return true;
      }
      return true; // image
    },

    "select.parent": () => {
      const before = selection.getSnapshot();
      selection.selectParent();
      return before.ids.length > 0 || before.enteredPath.length > 0 || before.edgeIds.length > 0;
    },
    "select.next": () =>
      selection.selectSibling("next") || selection.getSnapshot().edgeIds.length > 0,
    "select.previous": () =>
      selection.selectSibling("previous") || selection.getSnapshot().edgeIds.length > 0,
    // Display-only, no key binding — see the table rows' own comment.
    "select.deep": () => false,
    "select.layers": () => false,
    "select.through": () => false,

    "edit.deselect": () => {
      if (ctx.tool && ctx.tool.get() !== "move") {
        ctx.tool.set("move");
        return true;
      }
      const before = selection.getSnapshot();
      selection.escape();
      // Nothing left to step out of or deselect: below this, Escape belongs
      // to whoever is around us — how the user gets back to the document.
      return before.ids.length > 0 || before.edgeIds.length > 0 || before.enteredPath.length > 0;
    },

    "arrange.forward": () => reorder("forward"),
    "arrange.backward": () => reorder("backward"),
    "arrange.front": () => reorder("front"),
    "arrange.back": () => reorder("back"),

    "move.nudge": (e) => nudge(e, 1),
    "move.nudgeFar": (e) => nudge(e, 10),

    // The page's, not the diagram's — see the module header.
    "view.zoomIn": () => false,
    "view.zoomOut": () => false,
    "view.zoomReset": () => false,
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
}

// ---------------------------------------------------------------------------
// The container keymap
// ---------------------------------------------------------------------------

export interface CanvasShortcutOptions {
  scene: SceneStore;
  selection: SelectionStore;
  /** Also supplies the element the listeners bind to, via `containerRef`. */
  viewport: ViewportController;
  tool: ToolController;
  /** Where a nudge may go; `null` for a frame. */
  band: () => NudgeRange | null;
  /** Omitted where the surface has no vector edit mode to enter. */
  pathEdit?: PathEditController;
  /** Opens a shape's label for editing — Enter on a text-bearing node. Omitted where labels cannot be edited. */
  labelEdit?: { open(id: NodeId): void };
  /** Off for a read-only block, and for a diagram the page's keymap speaks for. Default true. */
  enabled?: boolean;
}

/**
 * Binds the keymap to one surface's viewport container — a storyboard's shot,
 * a harness. A diagram on the page is keyed by its pane instead (see
 * `page/pageKeymap.ts`).
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

    const scene = () => latest.current.scene.getScene();
    const targetIds = () =>
      topSelection(scene(), latest.current.selection.getSnapshot().ids).map((node) => node.id);

    const run = createNudgeRun(latest.current.scene, latest.current.selection);
    const commands = createDiagramCommands({
      get store() {
        return latest.current.scene;
      },
      get selection() {
        return latest.current.selection;
      },
      nudge: run,
      band: () => latest.current.band(),
      get tool() {
        return latest.current.tool;
      },
      get pathEdit() {
        return latest.current.pathEdit;
      },
      get labelEdit() {
        return latest.current.labelEdit;
      },
    });

    /** Paste canvas HTML beside where it was copied, or exactly there. */
    const paste = (html: string, inPlace: boolean): void => {
      const fragment = parseScene(html);
      if (fragment.nodes.length === 0) return;
      const current = scene();
      const parentId = pasteLevel(current, latest.current.selection);
      // The clipboard is in scene space; a group's children are in its own.
      const origin = parentId ? absoluteRect(current, parentId) : { x: 0, y: 0 };
      // Never above the top, where nothing is in sight.
      const offset = inPlace ? 0 : DUPLICATE_OFFSET;
      const dx = offset - origin.x;
      const dy = Math.max(offset, -unionBounds(fragment.nodes).y) - origin.y;
      const remap = new Map<NodeId, NodeId>();
      const copies = copiesInto(current, fragment.nodes, dx, dy, remap);
      const wanted = fragment.edges.filter((edge) => remap.has(edge.from) && remap.has(edge.to));
      const edgeIds = mintEdgeIds(current, wanted.length);
      const edges: SceneEdge[] = wanted.map((edge, i) => ({
        ...edge,
        id: edgeIds[i],
        from: remap.get(edge.from)!,
        to: remap.get(edge.to)!,
      }));
      // One dispatch, so the paste is one entry in history rather than a
      // separate undo for the shapes and the lines between them.
      latest.current.scene.dispatch(
        edges.length
          ? [
              { type: "insert", nodes: copies, parentId },
              { type: "addEdge", edges },
            ]
          : { type: "insert", nodes: copies, parentId },
      );
      latest.current.selection.select(copies.map((node) => node.id));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || isTextEntry()) return;
      const id = matchShortcut(e, apple);
      if (!id) return;
      if (id === "edit.paste" || id === "edit.pasteInPlace") pasteInPlace = id === "edit.pasteInPlace";
      // Anything but another nudge closes an open run first — so an unrelated
      // edit is never folded into it, and ⌘Z is not refused for the depth we
      // are holding.
      if (id !== "move.nudge" && id !== "move.nudgeFar") run.end();
      if (!commands[id](e)) return;
      e.preventDefault();
      // The canvas is inside a ProseMirror document that wants these same keys.
      e.stopPropagation();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (nudgeDelta(e)) run.end();
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
      const html = clipboardHtml(scene(), latest.current.selection.getSnapshot().ids);
      if (!html) return;
      rememberCopy(html);
      e.clipboardData?.setData("text/plain", html);
      e.preventDefault();
      e.stopPropagation();
    };

    const onCut = (e: ClipboardEvent) => {
      if (!isActive()) return;
      const ids = targetIds();
      onCopy(e);
      if (e.defaultPrevented && ids.length > 0) {
        latest.current.scene.dispatch({ type: "remove", ids });
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
      const html = isCanvasHtml(text) ? text : lastCopy()?.html;
      const inPlace = pasteInPlace;
      pasteInPlace = false;
      if (html) paste(html, inPlace);
    };

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("cut", onCut, true);
    document.addEventListener("paste", onPaste, true);
    return () => {
      // A bracket left open would wedge the store: undo and redo both refuse
      // while one is, and a remote scene waits for it.
      run.dispose();
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("cut", onCut, true);
      document.removeEventListener("paste", onPaste, true);
    };
    // `latest` carries the stores; only the element and the enabled flag decide
    // whether the listeners exist at all.
  }, [container, enabled]);
}
