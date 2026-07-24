import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * "Lucy Evening" — a soft, low-contrast dark theme (first pass; meant to be
 * refined on review). Muted plum background, gentle pastel tokens.
 */
const c = {
  bg: "#262233",
  fg: "#cfc9dd",
  caret: "#cbb8ff",
  selection: "#3a3450",
  comment: "#6f6a86",
  keyword: "#c3a6ff",
  string: "#a8d5b5",
  number: "#f0b49b",
  func: "#93c5e8",
  type: "#e0c48c",
  punct: "#b3adc4",
  tag: "#e58f8f",
  attr: "#e0c48c",
};

const eveningTheme = EditorView.theme(
  {
    "&": { backgroundColor: c.bg, color: c.fg, fontSize: "13px" },
    ".cm-content": {
      padding: "10px 14px",
      fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, monospace",
      caretColor: c.caret,
    },
    ".cm-scroller": { lineHeight: "1.6", fontFamily: "inherit" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.caret },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: c.selection },
    ".cm-gutters": { display: "none" },
    ".cm-line": { padding: "0" },
  },
  { dark: true },
);

const eveningHighlight = HighlightStyle.define([
  { tag: t.comment, color: c.comment, fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword, t.moduleKeyword], color: c.keyword },
  { tag: [t.string, t.special(t.string)], color: c.string },
  { tag: [t.number, t.bool, t.null, t.atom], color: c.number },
  { tag: [t.regexp, t.escape], color: c.number },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: c.func },
  { tag: [t.typeName, t.className, t.namespace], color: c.type },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.brace, t.paren], color: c.punct },
  { tag: t.tagName, color: c.tag },
  { tag: t.attributeName, color: c.attr },
  { tag: t.link, color: c.func, textDecoration: "underline" },
  { tag: t.heading, color: c.keyword, fontWeight: "bold" },
  { tag: t.meta, color: c.comment },
]);

export const eveningPalette = c;
export const eveningExtensions = [eveningTheme, syntaxHighlighting(eveningHighlight)];
