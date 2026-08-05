import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import katex from "katex";
import {
  CANVAS_MIN_H,
  sceneBlockHeight,
} from "@/app/components/editor/canvas/types";
import { runsToHtml } from "@/app/lib/ai/html/serialize";
import type { AnyBlock } from "@/app/lib/ai/projection";
import { ScenePreview, sceneFrom } from "./ScenePreview";

/**
 * Faded facsimiles of the blocks the document does not (yet, or any longer)
 * have.
 *
 * One set, two callers: a tab completion showing what accepting would insert,
 * and a review showing what discarding would bring back. Both are the same
 * claim — "this is that block, and it isn't real" — so they are the same
 * drawing, and only the head line differs.
 */


/**
 * A block that needs drawing to be understood.
 *
 * Ordinary text is deliberately not in here. A paragraph or a list the
 * completion would add is already legible as itself, and framing it in a
 * preview box says "here is a rendering of some text" about something that was
 * only ever text — it shows as ghost text instead, like any other prose.
 */
export type Preview =
  | { kind: "code"; language: string; code: string }
  | { kind: "math"; lines: string[] }
  /**
   * The diagram as the block stores it — canvas HTML, or the JSON a document
   * written before that still holds. Carried as its source rather than as a
   * digest of it, because the preview is drawn by the canvas's own renderer and
   * that renderer takes a scene: anything summarised here would be a fact about
   * the diagram that the drawing could then disagree with.
   */
  | { kind: "diagram"; source: string }
  /** Cells are inline MARKUP, not plain text, so a bold or `code` cell previews as one. */
  | { kind: "table"; header: boolean; rows: string[][] };

/** Inline elements the preview renders for real; anything else is unwrapped. */
const GHOST_TAGS: Record<string, string> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  u: "u",
  s: "s",
  code: "code",
  // Kept so a link in a deleted block still reads as one. No attributes are
  // copied here — by design, and it means the href does not come with it, so
  // what lands is an anchor that looks like a link and cannot be followed. That
  // is the right thing for a block that is not in the document any more.
  a: "a",
};

/**
 * Renders inline markup into real nodes, so a preview looks the way the block
 * looks — bold is bold, `code` wears the code chrome, `<nt-math>` renders
 * through KaTeX.
 *
 * Showing the raw tags instead was the tell that the preview and the real thing
 * were two different things. Parsing is forgiving by design: mid-stream the last
 * tag is usually incomplete, and the parser simply drops it.
 */
export function renderInline(source: string, into: HTMLElement) {
  const body = new DOMParser().parseFromString(
    `<body>${source}</body>`,
    "text/html",
  ).body;

  const walk = (node: Node, parent: HTMLElement) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      if (tag === "nt-math") {
        const span = document.createElement("span");
        try {
          span.innerHTML = katex.renderToString(el.textContent ?? "", {
            throwOnError: false,
          });
        } catch {
          span.textContent = el.textContent ?? "";
        }
        parent.appendChild(span);
        continue;
      }

      const mapped = GHOST_TAGS[tag];
      // Unknown tag: keep its text, drop the wrapper. A half-arrived block tag
      // must never show up as literal angle brackets.
      const next = mapped ? document.createElement(mapped) : parent;
      if (mapped) parent.appendChild(next);
      walk(el, next as HTMLElement);
    }
  };

  walk(body, into);
}

/**
 * A text block the document does not have yet. `html` is inline MARKUP, so a
 * bold word or a piece of `code` previews as itself.
 */
export type GhostBlock = {
  type: string;
  level?: number;
  checked?: boolean;
  /** First number of a numbered run that does not begin at 1. */
  start?: number;
  html: string;
  children?: GhostBlock[];
};

function div(className: string): HTMLElement {
  const el = document.createElement("div");
  if (className) el.className = className;
  return el;
}

/**
 * One block, wearing the editor's own class names.
 *
 * `index` is the number a numbered item shows. BlockNote reads it off
 * `data-index` (via `--index: attr(data-index)`), which in the real document a
 * plugin maintains — outside it, nobody does, and every item renders as a bare
 * ".".
 */
function ghostBlock(block: GhostBlock, index?: number): HTMLElement {
  const outer = div("bn-block-outer");
  const inner = div("bn-block");
  const content = div("bn-block-content");
  content.dataset.contentType = block.type;
  if (block.type === "heading") content.dataset.level = String(block.level ?? 2);
  if (index !== undefined) content.dataset.index = String(index);

  const inline = document.createElement("p");
  inline.className = "bn-inline-content";
  renderInline(block.html, inline);

  if (block.type === "quote") {
    const quote = document.createElement("blockquote");
    quote.appendChild(inline);
    content.appendChild(quote);
  } else if (block.type === "checkListItem") {
    const box = div("");
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.disabled = true;
    tick.checked = !!block.checked;
    box.appendChild(tick);
    content.appendChild(box);
    content.appendChild(inline);
  } else {
    content.appendChild(inline);
  }

  inner.appendChild(content);
  if (block.children?.length) {
    // Nested items sit in a group of their own, which is what the editor's
    // stylesheet indents — so the outline steps in by the same amount it will
    // once the suggestion is real.
    const group = div("bn-block-group");
    appendGhostBlocks(group, block.children);
    inner.appendChild(group);
  }
  outer.appendChild(inner);
  return outer;
}

function appendGhostBlocks(parent: HTMLElement, blocks: GhostBlock[]) {
  // Numbered items count within their own run, and anything else between two of
  // them starts the count again — the same thing the document would do. A run
  // opens at its own `start` when it has one, so a list carrying on from 4
  // previews as 4 rather than as a second list beginning at 1.
  let ordinal = 0;
  for (const block of blocks) {
    if (block.type !== "numberedListItem") ordinal = 0;
    else ordinal = ordinal ? ordinal + 1 : (block.start ?? 1);
    parent.appendChild(ghostBlock(block, ordinal || undefined));
  }
}

/**
 * Whole blocks a completion would add, drawn the way the editor draws its own.
 *
 * Reusing the editor's class names rather than restyling by hand is the whole
 * point: markers, indent and vertical rhythm all come from the stylesheet that
 * will lay the blocks out for real, so the preview cannot drift from the result
 * and accepting does not shift the page.
 *
 * NOT a `.bn-block-group` at the top — that class is what the editor indents
 * when it is nested inside another, and the preview is not an indent.
 */
export function ghostBlocksElement(blocks: GhostBlock[], live = false): HTMLElement {
  const wrap = div("nt-ghost-blocks");
  wrap.contentEditable = "false";
  appendGhostBlocks(wrap, blocks);
  // The preview cursor, at the end of the last block drawn. A suggestion makes
  // one promise — this is what you get, and this is where you will be — so it
  // gets one cursor, and `caretTarget` lands the real one in the same place.
  // The cursor is the head span's `::after`, so the line's content moves into
  // one and the Tab key — once the stream settles — sits after it.
  const lines = wrap.querySelectorAll("p.bn-inline-content");
  const end = lines[lines.length - 1];
  if (end) {
    const head = document.createElement("span");
    while (end.firstChild) head.appendChild(end.firstChild);
    head.classList.add("nt-stream-head");
    if (live) head.classList.add("is-live");
    end.appendChild(head);
    if (!live) end.appendChild(keyChip("Tab"));
  }
  return wrap;
}

/** A signature that changes whenever the drawing would, for widget reuse keys. */
export function ghostBlocksKey(blocks: GhostBlock[]): string {
  return blocks
    .map(
      (b) =>
        `${b.type}${b.level ?? ""}${b.start ?? ""}${b.checked ?? ""}:${b.html}` +
        (b.children ? `(${ghostBlocksKey(b.children)})` : ""),
    )
    .join("|");
}

/**
 * What a preview claims about itself: the key that would take it, and what it
 * is. Two fields rather than one sentence, because they are two different
 * things — one is a control and the other is a description, and glueing them
 * into `⇥ Tab to insert · 4 shapes` made the control impossible to draw as one.
 *
 * `live` means the model is still working on it, which is the one state that
 * has no key to offer yet.
 */
export type PreviewHead = { key?: string; label: string; live?: boolean };

/**
 * The key you would press, as a key rather than as a glyph in a sentence.
 *
 * Accent, because this is the model offering something — the same colour and
 * the same mono voice the reformat chip already uses for the same event. The
 * accent stops at the key: the description beside it is chrome.
 */
export function keyChip(key: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "nt-key";
  el.textContent = key;
  return el;
}

function headEl({ key, label, live }: PreviewHead) {
  const el = document.createElement("div");
  el.className = live ? "nt-code-preview-head is-live" : "nt-code-preview-head";
  if (key) el.appendChild(keyChip(key));
  el.appendChild(document.createTextNode(label));
  return el;
}

/**
 * React roots mounted into preview widgets, so each can be torn down when
 * ProseMirror drops the widget that owns it. A `WeakMap` rather than a property
 * on the element: the element is ProseMirror's, and a preview is rebuilt on
 * every keystroke of a streaming diagram.
 */
const roots = new WeakMap<Element, Root>();

/**
 * Unmount whatever a preview mounted. Handed to the widget decoration's
 * `destroy`, which is the only signal that the preview has gone.
 *
 * Deferred, because `destroy` fires while ProseMirror is applying a
 * transaction — which can be inside a React commit — and unmounting a root
 * from there is the "synchronously unmount while rendering" warning.
 */
export function disposePreview(node: Node): void {
  const el = node as Element;
  // The widget's node is not always the preview: a review draws a removed
  // diagram inside a wrapper that says it was removed, so the root is a
  // descendant. Both are checked, and a node that mounted nothing costs a
  // lookup that finds nothing.
  const owners: Element[] = [el];
  if (typeof el.querySelectorAll === "function") {
    owners.push(...el.querySelectorAll(".nt-diagram-preview"));
  }
  for (const owner of owners) {
    const root = roots.get(owner);
    if (!root) continue;
    roots.delete(owner);
    queueMicrotask(() => root.unmount());
  }
}

/**
 * The box a diagram is about to land in, before there is one to draw.
 *
 * The same chrome the finished preview wears, so the two are one box that fills
 * in rather than a chip that is replaced by something a different size — the
 * head line is the only part that changes. Deliberately not a rendering of
 * anything: the shapes here stand for a diagram, they do not claim to be the
 * one arriving, which is why they are three plain bars and not four.
 *
 * `nt-generating` is the app's mark for a block the model is still making — a
 * breathing accent edge, defined once in `globals.css`. It is what makes the
 * wait read as the model working rather than as a slow page: a dashed grey box
 * says "empty", and this box is not empty, it is busy.
 */
export function diagramSkeleton(label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "nt-diagram-preview is-loading nt-generating";
  wrap.contentEditable = "false";
  wrap.appendChild(headEl({ label, live: true }));

  const surface = div("nt-diagram-preview-surface is-waiting");
  surface.style.height = `${CANVAS_MIN_H}px`;
  for (let i = 0; i < 3; i++) {
    if (i) surface.appendChild(div("nt-skeleton-link"));
    surface.appendChild(div("nt-skeleton-shape"));
  }
  wrap.appendChild(surface);
  return wrap;
}

/** The diagram, drawn by the canvas's own renderer. */
function diagramPreview(source: string, head: PreviewHead) {
  const wrap = document.createElement("div");
  wrap.className = "nt-diagram-preview";
  wrap.contentEditable = "false";
  wrap.appendChild(headEl(head));

  const scene = sceneFrom(source);
  const surface = div("nt-diagram-preview-surface");
  // The height the block itself will take, by the block's own rule, so
  // accepting does not move the page.
  surface.style.height = `${sceneBlockHeight(scene)}px`;
  wrap.appendChild(surface);

  const root = createRoot(surface);
  roots.set(wrap, root);
  root.render(createElement(ScenePreview, { scene }));
  return wrap;
}

function mathPreview(lines: string[], head: PreviewHead) {
  const wrap = document.createElement("div");
  wrap.className = "nt-math-preview";
  wrap.contentEditable = "false";
  wrap.appendChild(headEl(head));
  for (const latex of lines) {
    const row = document.createElement("div");
    row.className = "nt-math-preview-row";
    row.innerHTML = katex.renderToString(latex, { throwOnError: false });
    wrap.appendChild(row);
  }
  return wrap;
}

function tablePreview(preview: { header: boolean; rows: string[][] }, head: PreviewHead) {
  const wrap = document.createElement("div");
  wrap.className = "nt-table-preview";
  wrap.contentEditable = "false";
  wrap.appendChild(headEl(head));

  const table = document.createElement("table");
  table.className = "nt-table-preview-grid";
  const tbody = document.createElement("tbody");
  preview.rows.forEach((cells, r) => {
    const tr = document.createElement("tr");
    for (const cell of cells) {
      const td = document.createElement(preview.header && r === 0 ? "th" : "td");
      // Same renderer as the ghost, so a cell holding maths or inline code
      // previews as the thing it will become rather than as its tags.
      renderInline(cell, td);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function codePreview(preview: { language: string; code: string }, head: PreviewHead) {
  const wrap = document.createElement("div");
  wrap.className = "nt-code-preview";
  wrap.contentEditable = "false";
  const body = document.createElement("pre");
  body.className = "nt-code-preview-body";
  body.textContent = preview.code;
  wrap.appendChild(headEl(head));
  wrap.appendChild(body);
  return wrap;
}

/** The faded block itself, headed by whatever the caller is claiming about it. */
export function previewElement(preview: Preview, head: PreviewHead): HTMLElement {
  switch (preview.kind) {
    case "code":
      return codePreview(preview, head);
    case "math":
      return mathPreview(preview.lines, head);
    case "table":
      return tablePreview(preview, head);
    case "diagram":
      return diagramPreview(preview.source, head);
  }
}

/** A signature that changes whenever the drawing would, for widget reuse keys. */
export function previewKey(p: Preview): string {
  switch (p.kind) {
    case "code":
      return `code-${p.code.length}`;
    case "math":
      return `math-${p.lines.join("|")}`;
    case "table":
      return `table-${p.rows.map((r) => r.join("|")).join("¶")}`;
    case "diagram":
      // The source itself. A count of shapes would hold the widget still while
      // a streaming diagram moved them, and re-labelled them, under it.
      return `diagram-${p.source.length}-${p.source}`;
  }
}

type TableCell = unknown[] | { content?: unknown[] };
type TableContent = { rows?: Array<{ cells?: TableCell[] }>; headerRows?: number };

/**
 * A diagram from what the block stores — canvas HTML, or the JSON a document
 * written before that still holds. Groups, connectors and every kind's own
 * geometry come with it: the canvas draws this, so whatever the canvas can draw
 * the preview shows.
 */
export function canvasPreview(
  source: string,
): Extract<Preview, { kind: "diagram" }> | null {
  // Parsed only to answer "is there anything to show" — a diagram with no
  // shapes in it is not an offer. The source travels on untouched, because the
  // renderer parses it for itself.
  if (!sceneFrom(source).nodes.length) return null;
  return { kind: "diagram", source };
}

/**
 * How a block draws when it is not in the document. `null` for the ordinary
 * text blocks, which have no chrome of their own and are drawn as a line of
 * inline content by the caller.
 */
export function previewOf(block: AnyBlock): Preview | null {
  switch (block.type) {
    case "codeBlock":
      return {
        kind: "code",
        language: String(block.props?.language ?? ""),
        code: String(block.props?.code ?? ""),
      };
    case "mathBlock": {
      const source = String(block.props?.source ?? "");
      return { kind: "math", lines: source.length ? source.split("\n") : [""] };
    }
    case "canvas":
      return canvasPreview(String(block.props?.data ?? ""));
    case "table": {
      const content = block.content as TableContent | undefined;
      const rows = content?.rows ?? [];
      if (!rows.length) return null;
      return {
        kind: "table",
        header: (content?.headerRows ?? 0) > 0,
        rows: rows.map((row) =>
          (row.cells ?? []).map((cell) =>
            runsToHtml(Array.isArray(cell) ? cell : cell.content),
          ),
        ),
      };
    }
    default:
      return null;
  }
}
