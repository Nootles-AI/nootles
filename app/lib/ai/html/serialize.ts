import { parseCanvas } from "@/app/components/editor/canvas/types";
import type { AnyBlock } from "../projection";
import { MARK_TAGS, type Mark, type Run } from "./grammar";

/**
 * Renders the document into the auto-board HTML grammar — the text the model
 * reads and completes.
 *
 * Code and LaTeX are emitted RAW, not entity-escaped: the parser treats those
 * elements as raw text (the way the HTML spec treats `<script>`), so escaping
 * would only add tokens and give the model something extra to get wrong.
 */

type SerializeOptions = {
  /** Marks the block holding the caret, so completions know where they are. */
  cursorBlockId?: string;
  /** Top-level blocks to include either side of the cursor. */
  window?: number;
};

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Escape prose only. Raw-text elements deliberately skip this. */
function esc(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

function attr(name: string, value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  return ` ${name}="${String(value).replace(/"/g, "&quot;")}"`;
}

function marksOf(styles: unknown): Mark[] {
  if (!styles || typeof styles !== "object") return [];
  const s = styles as Record<string, unknown>;
  return (Object.keys(MARK_TAGS) as Mark[]).filter((m) => s[m] === true);
}

function runsToHtml(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((item) => {
      if (item.type === "text") {
        const marks = marksOf(item.styles);
        let out = esc(String(item.text ?? ""));
        // Innermost first so nesting is stable when parsed back.
        for (const m of marks) out = `<${MARK_TAGS[m]}>${out}</${MARK_TAGS[m]}>`;
        return out;
      }
      if (item.type === "math") {
        const latex = (item.props as { latex?: string } | undefined)?.latex ?? "";
        return `<ab-math>${latex}</ab-math>`;
      }
      if (item.type === "link") {
        const href = String(item.href ?? "");
        return `<a${attr("href", href)}>${runsToHtml(item.content)}</a>`;
      }
      return "";
    })
    .join("");
}

/** Runs (from a parsed completion) back to HTML — used for previews/tests. */
export function runsToHtmlFromRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      if (r.type === "math") return `<ab-math>${r.latex}</ab-math>`;
      let out = esc(r.text);
      for (const m of r.marks ?? []) out = `<${MARK_TAGS[m]}>${out}</${MARK_TAGS[m]}>`;
      return out;
    })
    .join("");
}

function blockToHtml(block: AnyBlock, cursorBlockId?: string): string {
  const id = attr("id", block.id);
  const cursor = block.id === cursorBlockId ? ' data-cursor="1"' : "";
  const inner = runsToHtml(block.content);

  switch (block.type) {
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(block.props.level ?? 2)));
      return `<h${level}${id}${cursor}>${inner}</h${level}>`;
    }
    case "bulletListItem":
      return `<ul><li${id}${cursor}>${inner}</li></ul>`;
    case "numberedListItem":
      return `<ol><li${id}${cursor}>${inner}</li></ol>`;
    case "checkListItem": {
      const checked = block.props.checked ? " checked" : "";
      return `<ul><li${id}${cursor}><input type="checkbox"${checked}> ${inner}</li></ul>`;
    }
    case "quote":
      return `<blockquote${id}${cursor}>${inner}</blockquote>`;
    case "codeBlock": {
      const lang = String(block.props.language ?? "plaintext");
      // Raw, unescaped — the parser reads this element as raw text.
      return `<ab-code-block${id}${cursor}${attr("lang", lang)}>${String(
        block.props.code ?? "",
      )}</ab-code-block>`;
    }
    case "mathBlock": {
      const source = String(block.props.source ?? "");
      const rows = source.length ? source.split("\n") : [""];
      const lines = rows.map((r) => `\n  <ab-math-line>${r}</ab-math-line>`).join("");
      return `<ab-math-block${id}${cursor}>${lines}\n</ab-math-block>`;
    }
    case "canvas": {
      const { nodes, edges } = parseCanvas(String(block.props.data ?? ""));
      const nodeHtml = nodes
        .map(
          (n) =>
            `\n  <ab-node${attr("id", n.id)}${attr(
              "shape",
              String(n.data?.shape ?? "rectangle"),
            )}${attr("x", Math.round(n.position?.x ?? 0))}${attr(
              "y",
              Math.round(n.position?.y ?? 0),
            )}>${esc(String(n.data?.label ?? ""))}</ab-node>`,
        )
        .join("");
      const edgeHtml = edges
        .map((e) => {
          const label = typeof e.label === "string" ? e.label : "";
          return `\n  <ab-edge${attr("from", e.source)}${attr("to", e.target)}${attr(
            "label",
            label,
          )}></ab-edge>`;
        })
        .join("");
      return `<ab-diagram${id}${cursor}>${nodeHtml}${edgeHtml}\n</ab-diagram>`;
    }
    default:
      return `<p${id}${cursor}>${inner}</p>`;
  }
}

function collectIds(block: AnyBlock, out: Set<string>) {
  out.add(block.id);
  for (const c of block.children ?? []) collectIds(c, out);
}

export function toDocHtml(
  blocks: AnyBlock[],
  opts: SerializeOptions = {},
): string {
  let visible = blocks;
  if (opts.cursorBlockId && opts.window !== undefined) {
    const center = blocks.findIndex((b) => {
      const ids = new Set<string>();
      collectIds(b, ids);
      return ids.has(opts.cursorBlockId!);
    });
    if (center !== -1) {
      visible = blocks.slice(
        Math.max(0, center - opts.window),
        Math.min(blocks.length, center + opts.window + 1),
      );
    }
  }

  const out: string[] = [];
  const walk = (bs: AnyBlock[]) => {
    for (const b of bs) {
      out.push(blockToHtml(b, opts.cursorBlockId));
      if (b.children?.length) walk(b.children);
    }
  };
  walk(visible);
  return out.join("\n");
}
