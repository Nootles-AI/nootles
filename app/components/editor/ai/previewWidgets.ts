import katex from "katex";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import {
  canvasHeightFor,
  SHAPE_H,
  SHAPE_W,
} from "@/app/components/editor/canvas/types";
import { runsToHtml } from "@/app/lib/ai/html/serialize";
import type { AnyBlock } from "@/app/lib/ai/projection";

/**
 * Faded facsimiles of the blocks the document does not (yet, or any longer)
 * have.
 *
 * One set, two callers: a tab completion showing what accepting would insert,
 * and a review showing what discarding would bring back. Both are the same
 * claim — "this is that block, and it isn't real" — so they are the same
 * drawing, and only the head line differs.
 */

export type PreviewNode = {
  tempId: string;
  shape: string;
  label: string;
  x: number;
  y: number;
};
export type PreviewEdge = { source: string; target: string; label?: string };

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
  | { kind: "diagram"; nodes: PreviewNode[]; edges: PreviewEdge[] }
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
 * looks — bold is bold, `code` wears the code chrome, `<ab-math>` renders
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

      if (tag === "ab-math") {
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
  const wrap = div("ab-ghost-blocks");
  wrap.contentEditable = "false";
  appendGhostBlocks(wrap, blocks);
  // The preview cursor, at the end of the last block drawn. A suggestion makes
  // one promise — this is what you get, and this is where you will be — so it
  // gets one cursor, and `caretTarget` lands the real one in the same place.
  const lines = wrap.querySelectorAll("p.bn-inline-content");
  const end = lines[lines.length - 1];
  if (end) {
    end.classList.add("ab-stream-head");
    if (live) end.classList.add("is-live");
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

const SVG_NS = "http://www.w3.org/2000/svg";
// Match the canvas's real defaults so the preview reads true.
const NODE_W = SHAPE_W;
const NODE_H = SHAPE_H;

function svgEl(name: string, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function head(label: string) {
  const el = document.createElement("div");
  el.className = "ab-code-preview-head";
  el.textContent = label;
  return el;
}

/** A faded, to-scale sketch of a diagram. */
function diagramPreview(nodes: PreviewNode[], edges: PreviewEdge[], label: string) {
  const wrap = document.createElement("div");
  wrap.className = "ab-diagram-preview";
  wrap.contentEditable = "false";
  // Same height the real canvas takes, so accepting doesn't jump.
  wrap.style.height = `${canvasHeightFor(nodes)}px`;
  wrap.appendChild(head(label));

  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_W;
  const maxY = Math.max(...nodes.map((n) => n.y)) + NODE_H;
  const pad = 24;
  const svg = svgEl("svg", {
    class: "ab-diagram-preview-svg",
    viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
    preserveAspectRatio: "xMidYMid meet",
  });

  // Edges first so shapes sit on top.
  const byId = new Map(nodes.map((n) => [n.tempId, n]));
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    svg.appendChild(
      svgEl("line", {
        class: "ab-diagram-preview-edge",
        x1: a.x + NODE_W / 2,
        y1: a.y + NODE_H / 2,
        x2: b.x + NODE_W / 2,
        y2: b.y + NODE_H / 2,
      }),
    );
  }

  for (const n of nodes) {
    const cx = n.x + NODE_W / 2;
    const cy = n.y + NODE_H / 2;
    if (n.shape === "ellipse") {
      svg.appendChild(
        svgEl("ellipse", {
          class: "ab-diagram-preview-shape",
          cx,
          cy,
          rx: NODE_W / 2,
          ry: NODE_H / 2,
        }),
      );
    } else if (n.shape === "diamond") {
      svg.appendChild(
        svgEl("polygon", {
          class: "ab-diagram-preview-shape",
          points: `${cx},${n.y} ${n.x + NODE_W},${cy} ${cx},${n.y + NODE_H} ${n.x},${cy}`,
        }),
      );
    } else if (n.shape !== "text") {
      svg.appendChild(
        svgEl("rect", {
          class: "ab-diagram-preview-shape",
          x: n.x,
          y: n.y,
          width: NODE_W,
          height: NODE_H,
          rx: 8,
        }),
      );
    }
    const text = svgEl("text", {
      class: "ab-diagram-preview-text",
      x: cx,
      y: cy,
      "text-anchor": "middle",
      "dominant-baseline": "central",
    });
    text.textContent = n.label;
    svg.appendChild(text);
  }

  wrap.appendChild(svg);
  return wrap;
}

function mathPreview(lines: string[], label: string) {
  const wrap = document.createElement("div");
  wrap.className = "ab-math-preview";
  wrap.contentEditable = "false";
  wrap.appendChild(head(label));
  for (const latex of lines) {
    const row = document.createElement("div");
    row.className = "ab-math-preview-row";
    row.innerHTML = katex.renderToString(latex, { throwOnError: false });
    wrap.appendChild(row);
  }
  return wrap;
}

function tablePreview(preview: { header: boolean; rows: string[][] }, label: string) {
  const wrap = document.createElement("div");
  wrap.className = "ab-table-preview";
  wrap.contentEditable = "false";
  wrap.appendChild(head(label));

  const table = document.createElement("table");
  table.className = "ab-table-preview-grid";
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

function codePreview(preview: { language: string; code: string }, label: string) {
  const wrap = document.createElement("div");
  wrap.className = "ab-code-preview";
  wrap.contentEditable = "false";
  const body = document.createElement("pre");
  body.className = "ab-code-preview-body";
  body.textContent = preview.code;
  wrap.appendChild(head(label));
  wrap.appendChild(body);
  return wrap;
}

/** The faded block itself, headed by whatever the caller is claiming about it. */
export function previewElement(preview: Preview, label: string): HTMLElement {
  switch (preview.kind) {
    case "code":
      return codePreview(preview, label);
    case "math":
      return mathPreview(preview.lines, label);
    case "table":
      return tablePreview(preview, label);
    case "diagram":
      return diagramPreview(preview.nodes, preview.edges, label);
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
      return `diagram-${p.nodes.length}-${p.edges.length}`;
  }
}

type TableCell = unknown[] | { content?: unknown[] };
type TableContent = { rows?: Array<{ cells?: TableCell[] }>; headerRows?: number };

/**
 * A diagram sketched from what the block stores — canvas HTML, or the JSON a
 * document written before that still holds. Only the top level: the sketch
 * draws every shape at one size, so a group's contents would be a row of
 * identical boxes rather than the thing the group is.
 */
export function canvasPreview(
  source: string,
): Extract<Preview, { kind: "diagram" }> | null {
  const scene = migrateLegacyCanvas(source);
  if (!scene.nodes.length) return null;
  return {
    kind: "diagram",
    nodes: scene.nodes.map((node) => ({
      tempId: node.id,
      shape: node.kind === "ellipse" || node.kind === "text" ? node.kind : "rectangle",
      label: node.label,
      x: node.x,
      y: node.y,
    })),
    edges: [],
  };
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
