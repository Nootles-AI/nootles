import type { NmlBlock, NmlDocument, NmlInlineContent } from "@/app/lib/nml/schema";
import type { SceneNode } from "@/app/components/editor/canvas/scene/types";

/**
 * A served document as a flat list of blocks a person can look at — what the
 * MCP App card draws. The model reads `projectNmlDocument`'s text; this is the
 * human's view of the same canonical tree, derived from the same decode, so the
 * two never describe different documents.
 *
 * Pure and DOM-free: custom domains are summarized, never parsed.
 */

export type OutlineBlock = {
  id: string;
  type: NmlBlock["type"];
  /** Nesting under list items, 0 at the top. */
  depth: number;
  text: string;
  level?: number;
  checked?: boolean;
  language?: string;
};

export type Outline = {
  blocks: OutlineBlock[];
  /** Every block in the document, including those past the cut. */
  total: number;
  truncated: boolean;
};

export const OUTLINE_MAX_BLOCKS = 300;
export const OUTLINE_MAX_CHARS = 1200;

export function inlineText(content: NmlInlineContent): string {
  let out = "";
  for (const node of content) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "link":
        out += node.content.map((run) => run.text).join("");
        break;
      case "math":
        out += `$${node.latex}$`;
        break;
      case "pageRef":
        out += `@${node.fallbackTitle}`;
        break;
      case "checkbox":
        out += node.checked ? "☑" : "☐";
        break;
    }
  }
  return out;
}

function countShapes(nodes: SceneNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + ("children" in node ? countShapes(node.children) : 0);
  return n;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function blockText(block: NmlBlock): string {
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "heading":
    case "bulletListItem":
    case "numberedListItem":
    case "checkListItem":
    case "toggleListItem":
    case "comment":
      return inlineText(block.content);
    case "table":
      return block.rows
        .map((row) => row.cells.map((cell) => inlineText(cell.content)).join(" │ "))
        .join("\n");
    case "codeBlock":
      return block.code;
    case "mathBlock":
      return block.rows.map((row) => row.latex).join("\n");
    case "divider":
      return "";
    case "image":
    case "video":
    case "audio":
    case "file":
      return block.props.caption || block.props.name || "";
    case "canvas":
      return `Diagram · ${plural(countShapes(block.scene.nodes), "shape")}`;
    case "album":
      return `Album · ${plural(block.domain.items.length, "picture")}`;
    case "storyboard":
      return `Storyboard · ${plural(block.domain.shots.length, "shot")}`;
    case "location":
      return [block.domain.name, block.domain.address].filter(Boolean).join(" · ");
    case "notionStub":
      return `Notion ${block.props.notionType}`;
    case "commentThread":
      return block.props.anchor.exact;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function nmlOutline(
  document: NmlDocument,
  limits: { maxBlocks?: number; maxChars?: number } = {},
): Outline {
  const maxBlocks = limits.maxBlocks ?? OUTLINE_MAX_BLOCKS;
  const maxChars = limits.maxChars ?? OUTLINE_MAX_CHARS;
  const blocks: OutlineBlock[] = [];
  let total = 0;
  const walk = (list: NmlBlock[], depth: number) => {
    for (const block of list) {
      total += 1;
      if (blocks.length < maxBlocks) {
        const entry: OutlineBlock = { id: block.id, type: block.type, depth, text: clip(blockText(block), maxChars) };
        if (block.type === "heading") entry.level = block.props.level;
        if (block.type === "checkListItem") entry.checked = block.props.checked ?? false;
        if (block.type === "codeBlock" && block.props.language) entry.language = block.props.language;
        blocks.push(entry);
      }
      walk(block.children, depth + 1);
    }
  };
  walk(document.blocks, 0);
  return { blocks, total, truncated: total > blocks.length };
}

/**
 * The first words a person would recognize a document by. A page often opens
 * with its own title as a heading; beside the title that says nothing, so a
 * block repeating `title` is passed over.
 */
export function nmlSnippet(document: NmlDocument, { max = 180, title }: { max?: number; title?: string } = {}): string {
  const repeat = title?.trim().toLowerCase();
  const stack = [...document.blocks];
  while (stack.length) {
    const block = stack.shift()!;
    const text = blockText(block).replace(/\s+/g, " ").trim();
    if (text && text.toLowerCase() !== repeat) return clip(text, max);
    stack.unshift(...block.children);
  }
  return "";
}
