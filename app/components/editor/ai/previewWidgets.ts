import katex from "katex";
import {
  canvasHeightFor,
  parseCanvas,
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
    case "canvas": {
      const { nodes, edges } = parseCanvas(String(block.props?.data ?? ""));
      if (!nodes.length) return null;
      return {
        kind: "diagram",
        nodes: nodes.map((n) => ({
          tempId: n.id,
          shape: n.data?.shape ?? "rectangle",
          label: n.data?.label ?? "",
          x: n.position?.x ?? 0,
          y: n.position?.y ?? 0,
        })),
        edges: edges.map((e) => ({
          source: e.source,
          target: e.target,
          ...(typeof e.label === "string" ? { label: e.label } : {}),
        })),
      };
    }
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
