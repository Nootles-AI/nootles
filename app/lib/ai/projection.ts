import { parseCanvas } from "@/app/components/editor/canvas/types";

/**
 * Projection: a deterministic, id-tagged serialization of the document that an
 * LLM can both READ and ADDRESS. It runs over BlockNote's block JSON
 * (`editor.document`) — the same denormalized tree the applier writes back to —
 * so projection and apply share one mental model, and neither needs a
 * server-side ProseMirror schema.
 *
 * Every element is tagged with its stable id as `⟦id⟧`, so the model can say
 * "update ⟦x⟧" and the op targets exactly that node. The same pass builds a
 * reverse `DocIndex` that the validate/resolve gate uses to reject references to
 * ids that don't exist.
 */

// Structural view of a BlockNote block (kept loose so this module stays pure and
// decoupled from the schema-specific generic Block type).
export type AnyBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children?: AnyBlock[];
};

type InlineItem =
  | { type: "text"; text: string; styles?: Record<string, unknown> }
  | { type: "link"; href?: string; content?: InlineItem[] }
  | { type: string; props?: Record<string, unknown> };

export type BlockIndexEntry = {
  type: string;
  /** Whether the block holds inline content (rejects setBlockContent otherwise). */
  hasContent: boolean;
  parentId?: string;
};

export type DocIndex = {
  blocks: Map<string, BlockIndexEntry>;
  /** shapeId → its canvas block. */
  shapes: Map<string, { canvasBlockId: string }>;
  /** edgeId → its canvas block. */
  edges: Map<string, { canvasBlockId: string }>;
  /** mathBlock id → number of rows (bounds-checks updateMathRow). */
  mathRows: Map<string, number>;
};

function emptyIndex(): DocIndex {
  return {
    blocks: new Map(),
    shapes: new Map(),
    edges: new Map(),
    mathRows: new Map(),
  };
}

/** Render inline content to markdown-ish text (marks preserved, math as $…$). */
function inlineToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as InlineItem[])
    .map((item) => {
      if (item.type === "text") {
        const t = item as { text: string; styles?: Record<string, unknown> };
        return applyMarks(t.text, t.styles);
      }
      if (item.type === "link") {
        const l = item as { content?: InlineItem[] };
        return inlineToText(l.content);
      }
      if (item.type === "math") {
        const latex = (item as { props?: { latex?: string } }).props?.latex ?? "";
        return `$${latex}$`;
      }
      return "";
    })
    .join("");
}

/** Plain text with no marks — for shape labels and other attribute-like text. */
function inlinePlain(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as InlineItem[])
    .map((item) =>
      item.type === "text" ? (item as { text: string }).text : "",
    )
    .join("");
}

function applyMarks(text: string, styles?: Record<string, unknown>): string {
  if (!styles) return text;
  let out = text;
  if (styles.code) out = `\`${out}\``;
  if (styles.bold) out = `**${out}**`;
  if (styles.italic) out = `*${out}*`;
  if (styles.strike) out = `~~${out}~~`;
  if (styles.underline) out = `<u>${out}</u>`;
  return out;
}

function tag(id: string): string {
  return `⟦${id}⟧`;
}

function projectCanvas(block: AnyBlock, index: DocIndex, lines: string[]) {
  const { nodes, edges } = parseCanvas(String(block.props.data ?? ""));
  lines.push(`canvas ${tag(block.id)}`);
  for (const n of nodes) {
    index.shapes.set(n.id, { canvasBlockId: block.id });
    const label = (n.data?.label ?? "").replace(/\n/g, " ");
    const w = Math.round(n.width ?? 0);
    const h = Math.round(n.height ?? 0);
    const x = Math.round(n.position?.x ?? 0);
    const y = Math.round(n.position?.y ?? 0);
    lines.push(
      `  ${tag(n.id)} ${n.data?.shape ?? "rectangle"} "${label}" @(${x},${y}) ${w}x${h}`,
    );
  }
  for (const e of edges) {
    index.edges.set(e.id, { canvasBlockId: block.id });
    const labelText = typeof e.label === "string" ? e.label : "";
    const label = labelText ? ` : "${labelText}"` : "";
    lines.push(`  ${tag(e.id)} ${tag(e.source)} -> ${tag(e.target)}${label}`);
  }
}

function projectBlock(
  block: AnyBlock,
  index: DocIndex,
  lines: string[],
  parentId: string | undefined,
) {
  const hasContent = Array.isArray(block.content);
  index.blocks.set(block.id, { type: block.type, hasContent, parentId });

  const id = tag(block.id);
  switch (block.type) {
    case "heading": {
      const level = Number(block.props.level ?? 1);
      lines.push(`${id} ${"#".repeat(level)} ${inlineToText(block.content)}`);
      break;
    }
    case "bulletListItem":
      lines.push(`${id} - ${inlineToText(block.content)}`);
      break;
    case "numberedListItem":
      lines.push(`${id} 1. ${inlineToText(block.content)}`);
      break;
    case "checkListItem": {
      const box = block.props.checked ? "[x]" : "[ ]";
      lines.push(`${id} - ${box} ${inlineToText(block.content)}`);
      break;
    }
    case "quote":
      lines.push(`${id} > ${inlineToText(block.content)}`);
      break;
    case "codeBlock": {
      const lang = String(block.props.language ?? "");
      const code = String(block.props.code ?? "");
      lines.push(`${id} \`\`\`${lang}`);
      for (const l of code.split("\n")) lines.push(`  ${l}`);
      lines.push("  ```");
      break;
    }
    case "mathBlock": {
      const source = String(block.props.source ?? "");
      const rows = source.length ? source.split("\n") : [""];
      index.mathRows.set(block.id, rows.length);
      lines.push(`${id} math`);
      rows.forEach((r, i) => lines.push(`  [${i}] ${r}`));
      break;
    }
    case "canvas":
      projectCanvas(block, index, lines);
      break;
    default:
      // paragraph and any other text block.
      lines.push(`${id} ${inlineToText(block.content)}`);
  }

  for (const child of block.children ?? []) {
    projectBlock(child, index, lines, block.id);
  }
}

export function project(blocks: AnyBlock[]): { text: string; index: DocIndex } {
  const index = emptyIndex();
  const lines: string[] = [];
  for (const block of blocks) projectBlock(block, index, lines, undefined);
  return { text: lines.join("\n"), index };
}

export { inlinePlain };
