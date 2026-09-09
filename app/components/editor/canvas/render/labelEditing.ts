"use client";

import { useSyncExternalStore } from "react";

/**
 * The label under edit, offered to the style panel.
 *
 * Figma's inspector edits the selected range while a text layer is open and
 * the whole layer otherwise; this is the seam that makes the same true here.
 * The label editor registers itself on mount, the panel asks
 * {@link useLabelSelection} whether a range is live, and the two write
 * functions land marks and declarations on that range through the browser's
 * own editing — `execCommand` for the marks that have a tag, a wrapped
 * `<span style>` for the rest — so what the editor commits is the same HTML a
 * hand would have typed.
 *
 * One slot, module-wide, because one label is open at a time: the editor's
 * cleanup is what makes that true rather than hopeful.
 */

export type LabelSelection = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Computed, in px. */
  fontSize: number;
  /** Computed `font-family`, as the browser resolved it. */
  fontFamily: string;
  fontWeight: string;
  color: string;
  textTransform: string;
  letterSpacing: string;
};

type Editor = { el: HTMLElement; onChange: () => void };

let editor: Editor | null = null;
let snapshot: LabelSelection | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

function liveRange(): Range | null {
  const selection = window.getSelection();
  if (!editor || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return editor.el.contains(range.commonAncestorContainer) ? range : null;
}

function read() {
  const range = liveRange();
  if (!range) {
    if (snapshot) {
      snapshot = null;
      notify();
    }
    return;
  }
  const at = range.startContainer;
  const el = at.nodeType === 3 ? at.parentElement : (at as Element);
  if (!el) return;
  const cs = getComputedStyle(el);
  snapshot = {
    bold: Number.parseInt(cs.fontWeight, 10) >= 600,
    italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
    underline: cs.textDecorationLine.includes("underline"),
    strike: cs.textDecorationLine.includes("line-through"),
    fontSize: Number.parseFloat(cs.fontSize),
    fontFamily: cs.fontFamily,
    fontWeight: cs.fontWeight,
    color: cs.color,
    textTransform: cs.textTransform,
    letterSpacing: cs.letterSpacing,
  };
  notify();
}

/** Called by the label editor on mount. Returns the cleanup. */
export function registerLabelEditor(el: HTMLElement, onChange: () => void): () => void {
  editor = { el, onChange };
  document.addEventListener("selectionchange", read);
  read();
  return () => {
    document.removeEventListener("selectionchange", read);
    if (editor?.el === el) editor = null;
    if (snapshot) {
      snapshot = null;
      notify();
    }
  };
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const get = () => snapshot;
const none = () => null;

/** The selected range inside the open label, or null while there is none. */
export function useLabelSelection(): LabelSelection | null {
  return useSyncExternalStore(subscribe, get, none);
}

export type LabelMark = "bold" | "italic" | "underline" | "strike";

const COMMAND: Record<LabelMark, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikeThrough",
};

/** Toggle a mark on the selected range, the way ⌘B does. */
export function formatMark(mark: LabelMark): void {
  if (!liveRange() || !editor) return;
  editor.el.focus();
  document.execCommand(COMMAND[mark]);
  editor.onChange();
  read();
}

/**
 * Declarations onto the selected range: the range is lifted into a
 * `<span style>`, and the same properties are cleared from any span already
 * inside it, so the new value is the one that shows. `undefined` clears.
 */
export function formatStyle(decls: Record<string, string | undefined>): void {
  const range = liveRange();
  if (!range || !editor) return;
  const span = document.createElement("span");
  const fragment = range.extractContents();
  for (const inner of Array.from(fragment.querySelectorAll<HTMLElement>("[style]"))) {
    for (const prop in decls) inner.style.removeProperty(prop);
    if (!inner.getAttribute("style")) inner.removeAttribute("style");
  }
  for (const prop in decls) {
    const value = decls[prop];
    if (value !== undefined) span.style.setProperty(prop, value);
  }
  span.append(fragment);
  range.insertNode(span);
  const selection = window.getSelection();
  const next = document.createRange();
  next.selectNodeContents(span);
  selection?.removeAllRanges();
  selection?.addRange(next);
  editor.onChange();
  read();
}
