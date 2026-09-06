import { normalizeDocument } from "./normalize";
import { nmlDocumentSchema, type NmlBlock, type NmlDocument, type NmlIssue } from "./schema";
import { validateDocument } from "./validate";

export type NmlRepairResult = { document?: NmlDocument; issues: NmlIssue[]; changed: boolean };

function opaqueRepairId(seed: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < seed.length; index++) {
    const code = seed.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return `repair-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * Deterministic repair for already-merged v1 state. This function never writes;
 * only the elected backend repairer may persist its result.
 */
export function repairDocument(input: unknown): NmlRepairResult {
  const parsed = nmlDocumentSchema.safeParse(input);
  if (!parsed.success) return { issues: validateDocument(input), changed: false };
  const document = structuredClone(parsed.data);
  const issues: NmlIssue[] = [];
  const used = new Set<string>();
  const claim = (owner: { id: string }, path: Array<string | number>) => {
    if (!used.has(owner.id)) {
      used.add(owner.id);
      return;
    }
    const original = owner.id;
    let salt = 0;
    let repaired = opaqueRepairId(`${original}\0${path.join("/")}\0${salt}`);
    while (used.has(repaired)) repaired = opaqueRepairId(`${original}\0${path.join("/")}\0${++salt}`);
    owner.id = repaired;
    used.add(owner.id);
    issues.push({
      code: "duplicate_id_repaired",
      severity: "repair",
      nodeId: owner.id,
      path,
      message: `Later duplicate \"${original}\" was deterministically re-IDed as \"${owner.id}\".`,
      proposedRepair: "retain-first-reid-later",
    });
  };
  const visit = (block: NmlBlock, path: Array<string | number>) => {
    claim(block, path);
    if ("content" in block) {
      block.content.forEach((node, index) => {
        if (node.type === "math" || node.type === "pageRef") claim(node, [...path, "content", index]);
      });
    }
    if (block.type === "table") {
      block.columns.forEach((column, index) => claim(column, [...path, "columns", index]));
      block.rows.forEach((row, rowIndex) => {
        claim(row, [...path, "rows", rowIndex]);
        row.cells.forEach((cell, cellIndex) => claim(cell, [...path, "rows", rowIndex, "cells", cellIndex]));
      });
    }
    if (block.type === "mathBlock") block.rows.forEach((row, index) => claim(row, [...path, "rows", index]));
    if (block.type === "canvas") {
      const walkNodes = (nodes: typeof block.scene.nodes, nodePath: Array<string | number>) => nodes.forEach((node, index) => {
        claim(node, [...nodePath, index]);
        if (node.kind === "group") walkNodes(node.children, [...nodePath, index, "children"]);
      });
      walkNodes(block.scene.nodes, [...path, "scene", "nodes"]);
      block.scene.edges.forEach((edge, index) => claim(edge, [...path, "scene", "edges", index]));
    }
    block.children.forEach((child, index) => visit(child, [...path, "children", index]));
  };
  document.blocks.forEach((block, index) => visit(block, ["blocks", index]));
  const normalized = normalizeDocument(document);
  return { document: normalized, issues, changed: issues.length > 0 || JSON.stringify(normalized) !== JSON.stringify(parsed.data) };
}
