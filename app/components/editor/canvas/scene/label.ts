/**
 * A shape's label as canonical inline markup.
 *
 * A label is almost always plain words, but it may carry more: page
 * references — `<nt-ref page="…">Title</nt-ref>` — runs of styled text, and
 * paragraphs. The `label` field holds the words ALREADY escaped, with line
 * breaks as literal newlines and everything else as the HTML a browser would
 * accept for it: exactly the substring the serializer writes between the
 * shape's tags. That keeps the round trip byte-exact
 * (`serializeScene(parseScene(html)) === html`) without teaching the scene
 * model a second representation of rich text.
 *
 * The grammar is deliberately the web's own, because that is the language
 * the agents already read and write:
 *
 *   <b> <i> <u> <s>               weight, slant, underline, strike
 *   <a href="…">                  a link
 *   <span style="…">              anything CSS says about a run — size, colour, family
 *   <p style="…">                 a paragraph; `margin-bottom` is Figma's paragraph
 *                                 spacing, `text-indent` its indent
 *   <ul>/<ol> with <li>           lists
 *
 * A label with one unstyled paragraph is written without the `<p>`, which is
 * every label written before paragraphs existed, byte for byte.
 *
 * Everything that wants the label as something else goes through here: the
 * renderer and the editor read {@link labelBlocks}, the layers panel reads
 * {@link labelText}, the parser and the editor's commit read the DOM through
 * {@link labelOfElement}, and anything writing user-typed words into a label
 * goes through {@link textToLabel} so a typed `<` stays a `<`. Nothing renders
 * a label with `innerHTML` — runs become text nodes and elements — so markup
 * this module does not know is shown as the literal text it is, never
 * executed.
 */

import { safeHref } from "@/app/lib/ai/html/parse";

export type LabelStyle = Readonly<Record<string, string>>;

/** What a run of text wears. Absent and `false` are one thing. */
export type LabelMarks = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  href?: string;
  /** The `<span style>` around it, as declarations. */
  style?: LabelStyle;
};

export type LabelRun =
  | { kind: "text"; text: string; marks: LabelMarks }
  | { kind: "ref"; pageId: string; title: string };

/**
 * One paragraph or list item. `list` names the list an `li` belongs to.
 * `style` is the block's own declarations: paragraph spacing and indent.
 */
export type LabelBlock = {
  kind: "p" | "li";
  list?: "ul" | "ol";
  style?: LabelStyle;
  runs: LabelRun[];
};

export const NO_MARKS: LabelMarks = Object.freeze({});

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Plain words → their place in a label. */
export function textToLabel(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

function escAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

/** A page reference → its place in a label. */
export function refToLabel(pageId: string, title: string): string {
  return `<nt-ref page="${escAttr(pageId)}">${textToLabel(title)}</nt-ref>`;
}

// ---------------------------------------------------------------------------
// Styles: one spelling
// ---------------------------------------------------------------------------

/**
 * The declarations a run or a block may carry. An allow-list, because a span's
 * `style` is authored by an editor and by a model, and `position: absolute` on
 * a word is not a word anyone meant.
 */
const RUN_PROPS = new Set([
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "color",
  "letter-spacing",
  "text-transform",
  "text-decoration",
  "background-color",
]);
const BLOCK_PROPS = new Set(["margin-bottom", "margin-top", "text-indent", "text-align"]);

/** `a: b; c: d` → declarations, lowercase keys, trimmed values. */
export function parseStyle(text: string, allowed: ReadonlySet<string>): LabelStyle | undefined {
  const out: Record<string, string> = {};
  for (const part of text.split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (prop && value && allowed.has(prop)) out[prop] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Declarations → the one string, keys sorted, so equal styles are equal text. */
export function styleToText(style: LabelStyle): string {
  return Object.keys(style)
    .sort()
    .map((prop) => `${prop}: ${style[prop]}`)
    .join("; ");
}

function sameStyle(a: LabelStyle | undefined, b: LabelStyle | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return styleToText(a) === styleToText(b);
}

export function sameMarks(a: LabelMarks, b: LabelMarks): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    (a.href ?? "") === (b.href ?? "") &&
    sameStyle(a.style, b.style)
  );
}

/** Marks with nothing false or empty in them, so equal marks are equal objects. */
function tidyMarks(marks: LabelMarks): LabelMarks {
  const out: LabelMarks = {};
  if (marks.bold) out.bold = true;
  if (marks.italic) out.italic = true;
  if (marks.underline) out.underline = true;
  if (marks.strike) out.strike = true;
  if (marks.href) out.href = marks.href;
  if (marks.style && Object.keys(marks.style).length) out.style = marks.style;
  return Object.keys(out).length ? out : NO_MARKS;
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

/**
 * The fixed nesting, outermost first. One order is what makes the text
 * canonical: `<b><i>x</i></b>` and `<i><b>x</b></i>` are the same marks and
 * must come out as the same bytes.
 */
type Tag = { open: string; close: string };

function tagsOf(marks: LabelMarks): Tag[] {
  const out: Tag[] = [];
  if (marks.href) out.push({ open: `<a href="${escAttr(marks.href)}">`, close: "</a>" });
  if (marks.style && Object.keys(marks.style).length) {
    out.push({ open: `<span style="${escAttr(styleToText(marks.style))}">`, close: "</span>" });
  }
  if (marks.bold) out.push({ open: "<b>", close: "</b>" });
  if (marks.italic) out.push({ open: "<i>", close: "</i>" });
  if (marks.underline) out.push({ open: "<u>", close: "</u>" });
  if (marks.strike) out.push({ open: "<s>", close: "</s>" });
  return out;
}

/**
 * Runs → the one canonical string: escaped text, and the fewest tags that say
 * the marks. Tags stay open across runs that share them and close only when
 * the next run stops wearing them, innermost first.
 */
export function runsToLabel(runs: readonly LabelRun[]): string {
  let out = "";
  let open: Tag[] = [];
  for (const run of runs) {
    if (run.kind === "text" && run.text === "") continue;
    const wants = run.kind === "text" ? tagsOf(run.marks) : [];
    let shared = 0;
    while (
      shared < open.length &&
      shared < wants.length &&
      open[shared].open === wants[shared].open
    ) {
      shared += 1;
    }
    for (let i = open.length - 1; i >= shared; i -= 1) out += open[i].close;
    for (let i = shared; i < wants.length; i += 1) out += wants[i].open;
    open = wants;
    out += run.kind === "text" ? textToLabel(run.text) : refToLabel(run.pageId, run.title);
  }
  for (let i = open.length - 1; i >= 0; i -= 1) out += open[i].close;
  return out;
}

function isPlainParagraph(block: LabelBlock): boolean {
  return block.kind === "p" && !block.style;
}

/**
 * Blocks → the canonical label. A single unstyled paragraph is written bare,
 * so a label that never had paragraphs is the bytes it always was.
 */
export function blocksToLabel(blocks: readonly LabelBlock[]): string {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && isPlainParagraph(blocks[0])) return runsToLabel(blocks[0].runs);
  let out = "";
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  for (const block of blocks) {
    const kind = block.kind === "li" ? (block.list ?? "ul") : null;
    if (kind !== list) {
      closeList();
      if (kind) out += `<${kind}>`;
      list = kind;
    }
    const tag = block.kind === "li" ? "li" : "p";
    const style = block.style ? ` style="${escAttr(styleToText(block.style))}"` : "";
    out += `<${tag}${style}>${runsToLabel(block.runs)}</${tag}>`;
  }
  closeList();
  return out;
}

// ---------------------------------------------------------------------------
// Parsing the stored string
// ---------------------------------------------------------------------------

/** The named entities {@link textToLabel} writes, read back. */
function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : '"',
  );
}

const TOKEN =
  /<nt-ref\b([^>]*)>([\s\S]*?)<\/nt-ref\s*>|<(\/?)(b|i|u|s|a|span|p|ul|ol|li)\b([^>]*)>/gi;
const PAGE_ATTR = /\bpage\s*=\s*"([^"]*)"/i;
const HREF_ATTR = /\bhref\s*=\s*"([^"]*)"/i;
const STYLE_ATTR = /\bstyle\s*=\s*"([^"]*)"/i;

/**
 * A label, read back as blocks. Tags this grammar knows toggle marks or open
 * blocks; anything else — including markup some other author put there — is
 * words, exactly as typed. Unbalanced tags are tolerated: a close with nothing
 * open is ignored, and whatever is still open at the end is closed.
 */
export function labelBlocks(label: string): LabelBlock[] {
  const blocks: LabelBlock[] = [];
  let current: LabelBlock | null = null;
  let list: "ul" | "ol" | undefined;
  const counts = { bold: 0, italic: 0, underline: 0, strike: 0 };
  const hrefs: string[] = [];
  const styles: (LabelStyle | undefined)[] = [];

  const marks = (): LabelMarks => {
    let style: Record<string, string> | undefined;
    for (const s of styles) {
      if (!s) continue;
      style = { ...(style ?? {}), ...s };
    }
    return tidyMarks({
      bold: counts.bold > 0,
      italic: counts.italic > 0,
      underline: counts.underline > 0,
      strike: counts.strike > 0,
      href: hrefs.length ? hrefs[hrefs.length - 1] : undefined,
      style,
    });
  };
  const into = (): LabelBlock => {
    if (!current) {
      current = { kind: "p", runs: [] };
      blocks.push(current);
    }
    return current;
  };
  const push = (run: LabelRun) => {
    const block = into();
    const tail = block.runs[block.runs.length - 1];
    if (run.kind === "text" && tail?.kind === "text" && sameMarks(tail.marks, run.marks)) {
      tail.text += run.text;
    } else {
      block.runs.push(run);
    }
  };
  const text = (from: number, to: number) => {
    if (to > from) push({ kind: "text", text: unescape(label.slice(from, to)), marks: marks() });
  };

  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(label); m; m = TOKEN.exec(label)) {
    if (m[2] !== undefined && m[1] !== undefined) {
      const pageId = PAGE_ATTR.exec(m[1])?.[1];
      if (pageId === undefined) continue;
      text(last, m.index);
      push({ kind: "ref", pageId: unescape(pageId), title: unescape(m[2]) });
      last = m.index + m[0].length;
      continue;
    }
    text(last, m.index);
    last = m.index + m[0].length;
    const closing = m[3] === "/";
    const tag = m[4].toLowerCase();
    const attrs = m[5] ?? "";
    switch (tag) {
      case "b":
      case "i":
      case "u":
      case "s": {
        const key = tag === "b" ? "bold" : tag === "i" ? "italic" : tag === "u" ? "underline" : "strike";
        if (!closing) counts[key] += 1;
        else if (counts[key] > 0) counts[key] -= 1;
        break;
      }
      case "a":
        if (!closing) hrefs.push(unescape(HREF_ATTR.exec(attrs)?.[1] ?? ""));
        else hrefs.pop();
        break;
      case "span":
        if (!closing) styles.push(parseStyle(unescape(STYLE_ATTR.exec(attrs)?.[1] ?? ""), RUN_PROPS));
        else styles.pop();
        break;
      case "ul":
      case "ol":
        current = null;
        list = closing ? undefined : tag;
        break;
      case "p":
      case "li":
        if (closing) {
          current = null;
        } else {
          const style = parseStyle(unescape(STYLE_ATTR.exec(attrs)?.[1] ?? ""), BLOCK_PROPS);
          current = {
            kind: tag === "li" ? "li" : "p",
            ...(tag === "li" ? { list: list ?? "ul" } : {}),
            ...(style ? { style } : {}),
            runs: [],
          };
          blocks.push(current);
        }
        break;
    }
  }
  text(last, label.length);
  return blocks.length ? blocks : [{ kind: "p", runs: [] }];
}

/** The label's runs in order, paragraphs joined by a newline. */
export function labelRuns(label: string): LabelRun[] {
  const out: LabelRun[] = [];
  labelBlocks(label).forEach((block, i) => {
    if (i > 0) out.push({ kind: "text", text: "\n", marks: NO_MARKS });
    out.push(...block.runs);
  });
  return out;
}

/** The label as plain words — a ref reads as its title, marks as their text. */
export function labelText(label: string): string {
  return labelRuns(label)
    .map((run) => (run.kind === "text" ? run.text : run.title))
    .join("");
}

/** True when the label is more than one bare paragraph. */
export function hasBlocks(label: string): boolean {
  const blocks = labelBlocks(label);
  return blocks.length > 1 || !isPlainParagraph(blocks[0]);
}

// ---------------------------------------------------------------------------
// Editing helpers — the panel's whole-label writes
// ---------------------------------------------------------------------------

/**
 * Figma's paragraph spacing, written as each paragraph's `margin-bottom`. The
 * last block carries none, so the label ends where its words do.
 */
export function withParagraphSpacing(label: string, px: number | undefined): string {
  const blocks = labelBlocks(label);
  return blocksToLabel(
    blocks.map((block, i) => {
      const style: Record<string, string> = { ...(block.style ?? {}) };
      delete style["margin-bottom"];
      if (px !== undefined && px > 0 && i < blocks.length - 1) style["margin-bottom"] = `${px}px`;
      return { ...block, ...(Object.keys(style).length ? { style } : { style: undefined }) };
    }),
  );
}

export function paragraphSpacingOf(label: string): number {
  const first = labelBlocks(label)[0];
  const n = Number.parseFloat(first.style?.["margin-bottom"] ?? "");
  return Number.isFinite(n) ? n : 0;
}

export function withIndent(label: string, px: number | undefined): string {
  return blocksToLabel(
    labelBlocks(label).map((block) => {
      const style: Record<string, string> = { ...(block.style ?? {}) };
      delete style["text-indent"];
      if (px !== undefined && px !== 0) style["text-indent"] = `${px}px`;
      return { ...block, ...(Object.keys(style).length ? { style } : { style: undefined }) };
    }),
  );
}

export function indentOf(label: string): number {
  const first = labelBlocks(label)[0];
  const n = Number.parseFloat(first.style?.["text-indent"] ?? "");
  return Number.isFinite(n) ? n : 0;
}

export type ListKind = "" | "ul" | "ol";

/** Every block as an item of one list, or as a paragraph again. */
export function withList(label: string, list: ListKind): string {
  return blocksToLabel(
    labelBlocks(label).map((block) =>
      list
        ? { ...block, kind: "li", list }
        : { kind: "p", ...(block.style ? { style: block.style } : {}), runs: block.runs },
    ),
  );
}

export function listOf(label: string): ListKind {
  const first = labelBlocks(label)[0];
  return first.kind === "li" ? (first.list ?? "ul") : "";
}

// ---------------------------------------------------------------------------
// Reading the DOM — the parser's half, and the editor's commit
// ---------------------------------------------------------------------------

/** Non-canonical spellings of the ref tag, accepted on the way in. */
const REF_TAGS = new Set(["nt-ref", "ref", "page-ref", "mention"]);

/** Elements whose text is not label text under any reading. */
const SKIPPED = new Set(["script", "style", "template"]);

function isBoldWeight(weight: string): boolean {
  return weight === "bold" || weight === "bolder" || Number.parseInt(weight, 10) >= 600;
}

/** The ref an element is, if it is one: the grammar's tag, or the editor's chip. */
function refOf(el: Element): { pageId: string; title: string } | null {
  if (REF_TAGS.has(el.tagName.toLowerCase())) {
    const pageId = el.getAttribute("page");
    return pageId === null ? null : { pageId, title: el.textContent ?? "" };
  }
  const pageId = el.getAttribute("data-page");
  return pageId === null
    ? null
    : { pageId, title: el.getAttribute("data-title") ?? "" };
}

/**
 * The marks an element adds to what is inside it. Tags first, then the inline
 * style a browser's own editing commands write — `execCommand` bolds land as
 * `<b>` in one engine and `font-weight: 700` in another, and a `<font>` tag
 * is how some of them spell a colour.
 */
function marksOf(el: Element, inherited: LabelMarks): LabelMarks {
  const tag = el.tagName.toLowerCase();
  const next: LabelMarks = { ...inherited };
  if (tag === "b" || tag === "strong") next.bold = true;
  if (tag === "i" || tag === "em") next.italic = true;
  if (tag === "u") next.underline = true;
  if (tag === "s" || tag === "strike" || tag === "del") next.strike = true;
  if (tag === "a") {
    const href = safeHref(el.getAttribute("href") ?? "");
    if (href) next.href = href;
  }
  if (tag === "font") {
    const color = el.getAttribute("color");
    const face = el.getAttribute("face");
    const style: Record<string, string> = { ...(next.style ?? {}) };
    if (color) style.color = color;
    if (face) style["font-family"] = face;
    if (Object.keys(style).length) next.style = style;
  }
  const declared = el.getAttribute("style");
  if (declared) {
    const style = parseStyle(declared, RUN_PROPS);
    if (style) {
      const merged: Record<string, string> = { ...(next.style ?? {}), ...style };
      // The marks that have a tag are marks, not declarations: a bold span is
      // `<b>`, so the text is canonical whichever way the engine wrote it.
      if (merged["font-weight"] !== undefined && isBoldWeight(merged["font-weight"])) {
        next.bold = true;
        delete merged["font-weight"];
      }
      if (merged["font-style"] === "italic" || merged["font-style"] === "oblique") {
        next.italic = true;
        delete merged["font-style"];
      }
      const decoration = merged["text-decoration"];
      if (decoration !== undefined) {
        if (/underline/.test(decoration)) next.underline = true;
        if (/line-through/.test(decoration)) next.strike = true;
        delete merged["text-decoration"];
      }
      next.style = Object.keys(merged).length ? merged : undefined;
    }
  }
  return next;
}

/**
 * An element's inline content → a canonical label: the parser's half of the
 * round trip, and what the editor's commit reads out of its contentEditable.
 * Text is (re-)escaped, refs are kept as elements, marks survive their tags
 * and their styled-span spellings alike, `<br>` and `<div>` boundaries become
 * newlines, `<p>` and `<li>` become paragraphs and items, and any other markup
 * a model wrapped the words in is flattened to the words.
 */
export function labelOfElement(root: Element): string {
  const blocks: LabelBlock[] = [];
  let current: LabelBlock | null = null;
  /** Text outside any `<p>` lands in an implicit paragraph. */
  const into = (): LabelBlock => {
    if (!current) {
      current = { kind: "p", runs: [] };
      blocks.push(current);
    }
    return current;
  };
  const push = (run: LabelRun) => {
    into().runs.push(run);
  };
  const walk = (node: Node, marks: LabelMarks, list: "ul" | "ol" | undefined) => {
    // Numeric, not `Node.TEXT_NODE`: this runs against injected documents in
    // server-side code, where there is no DOM global to read.
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      if (text) push({ kind: "text", text, marks: tidyMarks(marks) });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIPPED.has(tag)) return;
    if (tag === "br") {
      push({ kind: "text", text: "\n", marks: tidyMarks(marks) });
      return;
    }
    const ref = refOf(el);
    if (ref) {
      push({ kind: "ref", ...ref });
      return;
    }
    if (tag === "ul" || tag === "ol") {
      current = null;
      el.childNodes.forEach((child) => walk(child, marks, tag));
      current = null;
      return;
    }
    if (tag === "p" || tag === "li") {
      const style = parseStyle(el.getAttribute("style") ?? "", BLOCK_PROPS);
      current = {
        kind: tag === "li" ? "li" : "p",
        ...(tag === "li" ? { list: list ?? "ul" } : {}),
        ...(style ? { style } : {}),
        runs: [],
      };
      blocks.push(current);
      el.childNodes.forEach((child) => walk(child, marks, list));
      current = null;
      return;
    }
    if (tag === "div" && (current?.runs.length ?? 0) > 0) {
      const tail = current!.runs[current!.runs.length - 1];
      if (tail.kind !== "text" || !tail.text.endsWith("\n")) {
        push({ kind: "text", text: "\n", marks: tidyMarks(marks) });
      }
    }
    const wraps = marksOf(el, marks);
    el.childNodes.forEach((child) => walk(child, wraps, list));
  };
  root.childNodes.forEach((child) => walk(child, NO_MARKS, undefined));
  return blocksToLabel(tidyBlocks(blocks));
}

/**
 * Blocks as the editor may leave them, made canonical: empty text dropped,
 * runs with one set of marks joined, whitespace off the ends, and empty
 * blocks at either end removed — an editable ends with a stray empty
 * paragraph more often than not.
 */
function tidyBlocks(blocks: LabelBlock[]): LabelBlock[] {
  const tidy = blocks.map((block) => {
    const runs: LabelRun[] = [];
    for (const run of block.runs) {
      if (run.kind === "text" && run.text === "") continue;
      const tail = runs[runs.length - 1];
      if (run.kind === "text" && tail?.kind === "text" && sameMarks(tail.marks, run.marks)) {
        tail.text += run.text;
      } else {
        runs.push(run.kind === "text" ? { ...run } : run);
      }
    }
    const first = runs[0];
    if (first?.kind === "text") first.text = first.text.replace(/^\s+/, "");
    const last = runs[runs.length - 1];
    if (last?.kind === "text") last.text = last.text.replace(/\s+$/, "");
    return { ...block, runs: runs.filter((run) => run.kind !== "text" || run.text !== "") };
  });
  while (tidy.length > 1 && tidy[0].runs.length === 0) tidy.shift();
  while (tidy.length > 1 && tidy[tidy.length - 1].runs.length === 0) tidy.pop();
  return tidy;
}
