import { PARTS } from "@/app/components/editor/location/types";
import {
  NML_MARKS,
  type NmlBlock,
  type NmlDocument,
  type NmlInlineContent,
  type NmlMark,
} from "./schema";

const markOrder = new Map<NmlMark, number>(NML_MARKS.map((mark, index) => [mark, index]));

function normalizedMarks(marks: readonly NmlMark[]): NmlMark[] {
  return [...new Set(marks)].sort((a, b) => markOrder.get(a)! - markOrder.get(b)!);
}

function prose(text: string): string {
  return text.replace(/[\t\n\f\r ]+/g, " ");
}

export function normalizeInline(content: NmlInlineContent): NmlInlineContent {
  const normalized: NmlInlineContent = [];
  for (const node of content) {
    if (node.type === "text") {
      const text = prose(node.text);
      if (!text) continue;
      const next = { ...node, text, marks: normalizedMarks(node.marks) };
      const previous = normalized.at(-1);
      if (
        previous?.type === "text" &&
        previous.marks.length === next.marks.length &&
        previous.marks.every((mark, index) => mark === next.marks[index])
      ) {
        previous.text = prose(previous.text + next.text);
      } else {
        normalized.push(next);
      }
      continue;
    }
    if (node.type === "link") {
      const linked = normalizeInline(node.content).filter((item) => item.type === "text");
      if (linked.length) normalized.push({ ...node, content: linked });
      continue;
    }
    normalized.push({ ...node });
  }
  return normalized;
}

function normalizeBlock(block: NmlBlock): NmlBlock {
  const children = block.children.map(normalizeBlock);
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "heading":
    case "bulletListItem":
    case "numberedListItem":
    case "checkListItem":
    case "toggleListItem":
      return { ...block, content: normalizeInline(block.content), children };
    case "table":
      return {
        ...block,
        props: { headerRows: Math.min(block.props.headerRows, block.rows.length) },
        rows: block.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({ ...cell, content: normalizeInline(cell.content) })),
        })),
        children,
      };
    case "album":
      return { ...block, domain: { ...block.domain, id: block.id }, children };
    case "storyboard":
      return { ...block, domain: { ...block.domain, id: block.id }, children };
    case "location":
      return {
        ...block,
        domain: {
          ...block.domain,
          id: block.id,
          off: PARTS.filter((part) => block.domain.off.includes(part)),
        },
        children,
      };
    case "canvas":
      return { ...block, scene: { ...block.scene, id: block.id }, children };
    default:
      return { ...block, children };
  }
}

export function normalizeDocument(document: NmlDocument): NmlDocument {
  return {
    schemaVersion: document.schemaVersion,
    documentId: document.documentId,
    blocks: document.blocks.map(normalizeBlock),
  };
}
