import type { SceneNode } from "@/app/components/editor/canvas/scene/types";
import {
  NML_LIMITS,
  NML_SCHEMA_VERSION,
  nmlDocumentSchema,
  type NmlBlock,
  type NmlDocument,
  type NmlInlineContent,
  type NmlIssue,
} from "./schema";

const textEncoder = new TextEncoder();

export function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^[./#?]/.test(trimmed)) return true;
  try {
    const protocol = new URL(trimmed).protocol.toLowerCase();
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function issue(
  issues: NmlIssue[],
  code: string,
  path: Array<string | number>,
  message: string,
  nodeId?: string,
): void {
  issues.push({ code, severity: "error", path, message, ...(nodeId ? { nodeId } : {}) });
}

function inspectInline(
  content: NmlInlineContent,
  path: Array<string | number>,
  ids: Map<string, Array<string | number>>,
  issues: NmlIssue[],
): number {
  let length = 0;
  content.forEach((node, index) => {
    const here = [...path, index];
    if (node.type === "text") length += node.text.length;
    else if (node.type === "link") {
      if (!isSafeUrl(node.href)) issue(issues, "unsafe_url", [...here, "href"], "URL scheme is not allowed.");
      length += inspectInline(node.content, [...here, "content"], ids, issues);
    } else {
      addId(node.id, here, ids, issues);
      length += node.type === "math" ? node.latex.length : node.fallbackTitle.length;
    }
  });
  return length;
}

function addId(
  id: string,
  path: Array<string | number>,
  ids: Map<string, Array<string | number>>,
  issues: NmlIssue[],
): void {
  const first = ids.get(id);
  if (first) {
    issue(issues, "duplicate_id", path, `ID \"${id}\" is already used at ${first.join(".")}.`, id);
  } else ids.set(id, path);
}

function sceneNodes(nodes: SceneNode[]): SceneNode[] {
  return nodes.flatMap((node) => [node, ...(node.kind === "group" ? sceneNodes(node.children) : [])]);
}

export function validateDocument(input: unknown): NmlIssue[] {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    typeof input.schemaVersion === "number" &&
    input.schemaVersion > NML_SCHEMA_VERSION
  ) {
    return [{
      code: "unsupported_schema_version",
      severity: "error",
      path: ["schemaVersion"],
      message: `Schema version ${input.schemaVersion} is newer than supported version ${NML_SCHEMA_VERSION}; the document is read-only.`,
    }];
  }
  const parsed = nmlDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((entry) => ({
      code: "invalid_schema",
      severity: "error" as const,
      path: entry.path.map(String),
      message: entry.message,
    }));
  }

  const document = parsed.data;
  const issues: NmlIssue[] = [];
  const ids = new Map<string, Array<string | number>>();
  let blocks = 0;
  let inlineUnits = 0;

  const visit = (block: NmlBlock, path: Array<string | number>, depth: number) => {
    blocks++;
    addId(block.id, path, ids, issues);
    if (depth > NML_LIMITS.maxBlockDepth) {
      issue(issues, "block_depth_limit", path, `Block depth exceeds ${NML_LIMITS.maxBlockDepth}.`, block.id);
    }
    if ("content" in block) inlineUnits += inspectInline(block.content, [...path, "content"], ids, issues);
    if (block.type === "table") {
      block.columns.forEach((column, index) => addId(column.id, [...path, "columns", index], ids, issues));
      block.rows.forEach((row, rowIndex) => {
        addId(row.id, [...path, "rows", rowIndex], ids, issues);
        if (row.cells.length !== block.columns.length) {
          issue(issues, "table_width", [...path, "rows", rowIndex, "cells"], "Every row must have one cell per stable column.", row.id);
        }
        row.cells.forEach((cell, cellIndex) => {
          addId(cell.id, [...path, "rows", rowIndex, "cells", cellIndex], ids, issues);
          inlineUnits += inspectInline(cell.content, [...path, "rows", rowIndex, "cells", cellIndex, "content"], ids, issues);
        });
      });
    } else if (block.type === "mathBlock") {
      block.rows.forEach((row, index) => addId(row.id, [...path, "rows", index], ids, issues));
    } else if (block.type === "canvas") {
      const nodes = sceneNodes(block.scene.nodes);
      const sceneIds = new Set(nodes.map((node) => node.id));
      nodes.forEach((node, index) => addId(node.id, [...path, "scene", "nodes", index], ids, issues));
      block.scene.edges.forEach((edge, index) => {
        addId(edge.id, [...path, "scene", "edges", index], ids, issues);
        if (!sceneIds.has(edge.from) || !sceneIds.has(edge.to)) {
          issue(issues, "dangling_edge", [...path, "scene", "edges", index], "Edge endpoints must name shapes in the same scene.", edge.id);
        }
      });
      nodes.forEach((node, index) => {
        if (node.kind === "image" && node.src && !isSafeUrl(node.src)) {
          issue(issues, "unsafe_url", [...path, "scene", "nodes", index, "src"], "Canvas image URL scheme is not allowed.", node.id);
        }
      });
    }
    if (block.type === "checkListItem" && block.props.checked === undefined) {
      issue(issues, "missing_checked", [...path, "props", "checked"], "Checklist items require a checked state.", block.id);
    }
    if (block.type !== "checkListItem" && "checked" in block.props) {
      issue(issues, "unexpected_checked", [...path, "props", "checked"], "Only checklist items may carry checked.", block.id);
    }
    if (block.type !== "numberedListItem" && "start" in block.props) {
      issue(issues, "unexpected_start", [...path, "props", "start"], "Only numbered list items may carry start.", block.id);
    }
    if ("source" in block.props && block.props.source?.kind === "url" && !isSafeUrl(block.props.source.url)) {
      issue(issues, "unsafe_url", [...path, "props", "source", "url"], "URL scheme is not allowed.", block.id);
    }
    if (block.type === "album" || block.type === "storyboard" || block.type === "location" || block.type === "canvas") {
      if (textEncoder.encode(JSON.stringify(block)).byteLength > NML_LIMITS.maxDomainBytes) {
        issue(issues, "domain_size_limit", path, `Domain payload exceeds ${NML_LIMITS.maxDomainBytes} bytes.`, block.id);
      }
      if (block.type === "album") {
        block.domain.items.forEach((item, index) => {
          [item.src, item.poster, item.of?.src, item.of?.poster].filter((url): url is string => url !== undefined).forEach((url) => {
            if (!isSafeUrl(url)) issue(issues, "unsafe_url", [...path, "domain", "items", index], "Album media URL scheme is not allowed.", block.id);
          });
        });
      } else if (block.type === "location") {
        block.domain.images.forEach((image, index) => {
          if (!isSafeUrl(image.src)) issue(issues, "unsafe_url", [...path, "domain", "images", index, "src"], "Location image URL scheme is not allowed.", block.id);
        });
      }
    }
    block.children.forEach((child, index) => visit(child, [...path, "children", index], depth + 1));
  };
  document.blocks.forEach((block, index) => visit(block, ["blocks", index], 1));
  if (blocks > NML_LIMITS.maxBlocks) issue(issues, "block_count_limit", ["blocks"], `Document exceeds ${NML_LIMITS.maxBlocks} blocks.`);
  if (inlineUnits > NML_LIMITS.maxInlineUtf16) issue(issues, "inline_size_limit", ["blocks"], `Document exceeds ${NML_LIMITS.maxInlineUtf16} inline UTF-16 units.`);
  return issues;
}

export function assertValidDocument(input: unknown): asserts input is NmlDocument {
  const issues = validateDocument(input);
  if (issues.length) throw new NmlValidationError(issues);
}

export class NmlValidationError extends Error {
  constructor(readonly issues: NmlIssue[]) {
    super(issues.map((entry) => `${entry.path.join(".")}: ${entry.message}`).join("\n"));
    this.name = "NmlValidationError";
  }
}
