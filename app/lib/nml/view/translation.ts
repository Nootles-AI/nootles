import type { Node as PmNode } from "prosemirror-model";
import type {
  NmlBlock,
  NmlDocument,
  NmlInlineContent,
  NmlMark,
  NmlTableBlock,
} from "../schema";
import type { NmlAnchor, NmlCommand } from "../commands";
import { NML_INLINE_BLOCK_TYPES, NmlProjection } from "./projection";

export type NmlProjectionTranslation = {
  commands: NmlCommand[];
  temporaryIds: string[];
  changedNodeIds: string[];
  document: NmlDocument;
};

type BlockPosition = { block: NmlBlock; parentId: string | null; index: number };

function positions(document: NmlDocument): Map<string, BlockPosition> {
  const result = new Map<string, BlockPosition>();
  const visit = (blocks: NmlBlock[], parentId: string | null) => blocks.forEach((block, index) => {
    result.set(block.id, { block, parentId, index });
    visit(block.children, block.id);
  });
  visit(document.blocks, null);
  return result;
}

function siblings(document: NmlDocument, parentId: string | null): NmlBlock[] {
  if (parentId === null) return document.blocks;
  return positions(document).get(parentId)?.block.children ?? [];
}

function sharedRanks(
  source: Map<string, BlockPosition>,
  other: Map<string, BlockPosition>,
): Map<string, number> {
  const grouped = new Map<string | null, Array<{ id: string; index: number }>>();
  for (const [id, value] of source) {
    if (other.get(id)?.parentId !== value.parentId) continue;
    const rows = grouped.get(value.parentId) ?? [];
    rows.push({ id, index: value.index });
    grouped.set(value.parentId, rows);
  }
  const ranks = new Map<string, number>();
  grouped.forEach((rows) => rows.sort((left, right) => left.index - right.index)
    .forEach((row, rank) => ranks.set(row.id, rank)));
  return ranks;
}

function anchorFor(
  document: NmlDocument,
  parentId: string | null,
  index: number,
  available: ReadonlySet<string>,
): NmlAnchor | undefined {
  const list = siblings(document, parentId);
  for (let cursor = index + 1; cursor < list.length; cursor++) {
    if (available.has(list[cursor].id)) return { beforeId: list[cursor].id };
  }
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (available.has(list[cursor].id)) return { afterId: list[cursor].id };
  }
  return undefined;
}

function inlineLength(content: NmlInlineContent): number {
  return content.reduce((total, node) => total + (node.type === "text"
    ? node.text.length
    : node.type === "link"
      ? inlineLength(node.content)
      : 1), 0);
}

function sliceInline(content: NmlInlineContent, from: number, to: number): NmlInlineContent {
  let offset = 0;
  const result: NmlInlineContent = [];
  for (const node of content) {
    const length = node.type === "text" ? node.text.length : node.type === "link" ? inlineLength(node.content) : 1;
    const start = Math.max(0, from - offset);
    const end = Math.min(length, to - offset);
    if (end > start) {
      if (node.type === "text") result.push({ ...node, text: node.text.slice(start, end) });
      else if (node.type === "link") result.push({
        ...node,
        content: sliceInline(node.content, start, end).filter(
          (part): part is Extract<NmlInlineContent[number], { type: "text" }> => part.type === "text",
        ),
      });
      else if (start === 0 && end === 1) result.push(structuredClone(node));
    }
    offset += length;
  }
  return result;
}

type InlineUnit = {
  length: number;
  text: string;
  semantic: string;
  exact: string;
  marks?: NmlMark[];
  href?: string;
  linkGroup?: number;
};

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function textUnits(text: string, marks: NmlMark[], href?: string, linkGroup?: number): InlineUnit[] {
  const parts = segmenter ? [...segmenter.segment(text)].map((part) => part.segment) : Array.from(text);
  return parts.map((part) => ({
    length: part.length,
    text: part,
    semantic: JSON.stringify({ text: part, href, linkGroup }),
    exact: JSON.stringify({ text: part, href, linkGroup, marks }),
    marks,
    href,
    linkGroup,
  }));
}

function inlineUnits(content: NmlInlineContent): InlineUnit[] {
  let linkGroup = 0;
  return content.flatMap((node): InlineUnit[] => {
    if (node.type === "text") return textUnits(node.text, node.marks);
    if (node.type === "link") {
      const group = linkGroup++;
      return node.content.flatMap((part) => textUnits(part.text, part.marks, node.href, group));
    }
    const exact = JSON.stringify(node);
    return [{ length: 1, text: exact, semantic: exact, exact }];
  });
}

function marksOnlyCommands(nodeId: string, before: InlineUnit[], after: InlineUnit[]): NmlCommand[] | null {
  if (before.length !== after.length || before.some((unit, index) => unit.semantic !== after[index].semantic)) return null;
  const commands: NmlCommand[] = [];
  let offset = 0;
  let start = -1;
  let marks: NmlMark[] | undefined;
  const flush = (end: number) => {
    if (start >= 0 && marks) commands.push({ type: "setInlineMarks", nodeId, range: { from: start, to: end }, marks });
    start = -1;
    marks = undefined;
  };
  before.forEach((unit, index) => {
    const next = after[index];
    const changed = unit.exact !== next.exact;
    const sameRun = changed && marks && JSON.stringify(marks) === JSON.stringify(next.marks);
    if (!changed) flush(offset);
    else if (!sameRun) {
      flush(offset);
      start = offset;
      marks = next.marks;
    }
    offset += unit.length;
  });
  flush(offset);
  return commands;
}

function linksOnlyCommands(nodeId: string, before: InlineUnit[], after: InlineUnit[]): NmlCommand[] | null {
  if (before.length !== after.length || before.some((unit, index) =>
    unit.text !== after[index].text || JSON.stringify(unit.marks) !== JSON.stringify(after[index].marks))) return null;
  const commands: NmlCommand[] = [];
  let offset = 0;
  let index = 0;
  while (index < before.length) {
    const start = offset;
    const href = after[index].href;
    const group = after[index].linkGroup;
    let changed = false;
    do {
      changed ||= before[index].href !== after[index].href || before[index].linkGroup !== after[index].linkGroup;
      offset += before[index].length;
      index++;
    } while (index < before.length && after[index].href === href && after[index].linkGroup === group);
    if (!changed) continue;
    commands.push({
      type: "setInlineLink",
      nodeId,
      range: { from: start, to: offset },
      href: href ?? null,
      ...(href ? { linkKey: `projection:${nodeId}:${start}:${offset}:${group ?? 0}:${encodeURIComponent(href)}` } : {}),
    });
  }
  return commands;
}

function inlineCommands(nodeId: string, before: NmlInlineContent, after: NmlInlineContent): NmlCommand[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const was = inlineUnits(before);
  const next = inlineUnits(after);
  const marked = marksOnlyCommands(nodeId, was, next);
  if (marked !== null) return marked;
  const linked = linksOnlyCommands(nodeId, was, next);
  if (linked !== null) return linked;
  let prefix = 0;
  while (prefix < was.length && prefix < next.length && was[prefix].exact === next[prefix].exact) prefix++;
  let suffix = 0;
  while (suffix < was.length - prefix && suffix < next.length - prefix &&
      was[was.length - 1 - suffix].exact === next[next.length - 1 - suffix].exact) suffix++;
  const from = was.slice(0, prefix).reduce((total, unit) => total + unit.length, 0);
  const to = was.slice(0, was.length - suffix).reduce((total, unit) => total + unit.length, 0);
  const insertedFrom = next.slice(0, prefix).reduce((total, unit) => total + unit.length, 0);
  const insertedTo = next.slice(0, next.length - suffix).reduce((total, unit) => total + unit.length, 0);
  return [{ type: "replaceInline", nodeId, range: { from, to }, content: sliceInline(after, insertedFrom, insertedTo) }];
}

function textDiff(before: string, after: string): { from: number; to: number; text: string } | null {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let suffix = 0;
  while (suffix < before.length - from && suffix < after.length - from &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { from, to: before.length - suffix, text: after.slice(from, after.length - suffix) };
}

function propsPatch(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown | undefined> {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => [key, key in after ? after[key] : undefined]));
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  const common = new Set(left.filter((id) => right.includes(id)));
  return left.filter((id) => common.has(id)).join("\0") === right.filter((id) => common.has(id)).join("\0");
}

function entityAnchor(ids: readonly string[], index: number, available: ReadonlySet<string>): NmlAnchor | undefined {
  for (let cursor = index + 1; cursor < ids.length; cursor++) {
    if (available.has(ids[cursor])) return { beforeId: ids[cursor] };
  }
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (available.has(ids[cursor])) return { afterId: ids[cursor] };
  }
  return undefined;
}

function tableCommands(before: NmlTableBlock, after: NmlTableBlock): NmlCommand[] {
  const commands: NmlCommand[] = [];
  const beforeRows = before.rows.map((row) => row.id);
  const afterRows = after.rows.map((row) => row.id);
  const beforeColumns = before.columns.map((column) => column.id);
  const afterColumns = after.columns.map((column) => column.id);
  if (!sameOrder(beforeRows, afterRows) || !sameOrder(beforeColumns, afterColumns)) throw new Error("Table row and column reordering is not supported.");

  const removedRows = beforeRows.filter((id) => !afterRows.includes(id));
  if (removedRows.length) commands.push({ type: "removeTableRows", tableId: before.id, rowIds: removedRows });
  const removedColumns = beforeColumns.filter((id) => !afterColumns.includes(id));
  if (removedColumns.length) commands.push({ type: "removeTableColumns", tableId: before.id, columnIds: removedColumns });

  const availableColumns = new Set(beforeColumns.filter((id) => !removedColumns.includes(id)));
  after.columns.forEach((column, index) => {
    if (beforeColumns.includes(column.id)) return;
    const cells = after.rows
      .filter((row) => beforeRows.includes(row.id) && !removedRows.includes(row.id))
      .map((row) => ({ rowId: row.id, cell: structuredClone(row.cells[index]) }));
    commands.push({
      type: "insertTableColumns",
      tableId: before.id,
      anchor: entityAnchor(afterColumns, index, availableColumns),
      columns: [{ id: column.id, cells }],
    });
    availableColumns.add(column.id);
  });

  const availableRows = new Set(beforeRows.filter((id) => !removedRows.includes(id)));
  after.rows.forEach((row, index) => {
    if (beforeRows.includes(row.id)) return;
    const anchor = entityAnchor(afterRows, index, availableRows);
    commands.push({ type: "insertTableRows", tableId: before.id, anchor, rows: [structuredClone(row)] });
    availableRows.add(row.id);
  });

  const rows = new Map(before.rows.map((row) => [row.id, row]));
  const beforeColumnIndex = new Map(before.columns.map((column, index) => [column.id, index]));
  after.rows.forEach((row) => row.cells.forEach((cell, columnIndex) => {
    const oldRow = rows.get(row.id);
    const oldColumn = beforeColumnIndex.get(after.columns[columnIndex]?.id);
    if (!oldRow || oldColumn === undefined) return;
    const oldCell = oldRow.cells[oldColumn];
    if (!oldCell || oldCell.id !== cell.id) throw new Error("Stable table cell identity changed.");
    if (JSON.stringify(oldCell.content) !== JSON.stringify(cell.content)) {
      commands.push({
        type: "replaceTableRange",
        tableId: before.id,
        rowIds: [row.id],
        columnIds: [after.columns[columnIndex].id],
        cells: [[structuredClone(cell)]],
      });
    }
  }));
  return commands;
}

function collectIds(document: NmlDocument): Set<string> {
  const result = new Set<string>();
  const inline = (content: NmlInlineContent) => content.forEach((node) => {
    if (node.type === "math" || node.type === "pageRef") result.add(node.id);
  });
  const visit = (block: NmlBlock) => {
    result.add(block.id);
    if ("content" in block) inline(block.content);
    if (block.type === "table") {
      block.columns.forEach((column) => result.add(column.id));
      block.rows.forEach((row) => { result.add(row.id); row.cells.forEach((cell) => { result.add(cell.id); inline(cell.content); }); });
    }
    if (block.type === "mathBlock") block.rows.forEach((row) => result.add(row.id));
    block.children.forEach(visit);
  };
  document.blocks.forEach(visit);
  return result;
}

export function compileProjectionChange(before: NmlDocument, after: NmlDocument): NmlProjectionTranslation {
  const was = positions(before);
  const next = positions(after);
  const commands: NmlCommand[] = [];
  const changed = new Set<string>();
  const inserted = new Set([...next.keys()].filter((id) => !was.has(id)));
  const removed = new Set([...was.keys()].filter((id) => !next.has(id)));

  for (const [id, prior] of was) {
    const current = next.get(id);
    if (!current) continue;
    if (prior.block.type !== current.block.type) {
      const mediaTypes = new Set(["image", "video", "audio", "file"]);
      if (NML_INLINE_BLOCK_TYPES.has(prior.block.type) && NML_INLINE_BLOCK_TYPES.has(current.block.type)) {
        commands.push({
          type: "setTextBlockType",
          nodeId: id,
          blockType: current.block.type as Extract<NmlCommand, { type: "setTextBlockType" }>["blockType"],
          props: structuredClone(current.block.props),
        });
      } else if (mediaTypes.has(prior.block.type) && mediaTypes.has(current.block.type)) {
        commands.push({
          type: "setMediaBlockType",
          nodeId: id,
          blockType: current.block.type as Extract<NmlCommand, { type: "setMediaBlockType" }>["blockType"],
        });
        const patch = propsPatch(prior.block.props, current.block.props);
        if (Object.keys(patch).length) commands.push({ type: "setNodeProps", nodeId: id, patch });
      } else {
        throw new Error("Only inline text or media block types can change through the projection.");
      }
      changed.add(id);
    } else {
      const patch = propsPatch(prior.block.props, current.block.props);
      if (Object.keys(patch).length) { commands.push({ type: "setNodeProps", nodeId: id, patch }); changed.add(id); }
    }
    if ("content" in prior.block && "content" in current.block) {
      inlineCommands(id, prior.block.content, current.block.content).forEach((command) => commands.push(command));
      if (JSON.stringify(prior.block.content) !== JSON.stringify(current.block.content)) changed.add(id);
    } else if (prior.block.type === "table" && current.block.type === "table") {
      const table = tableCommands(prior.block, current.block);
      commands.push(...table);
      if (table.length) changed.add(id);
    } else if (prior.block.type === "codeBlock" && current.block.type === "codeBlock") {
      const diff = textDiff(prior.block.code, current.block.code);
      if (diff) { commands.push({ type: "setCode", nodeId: id, range: { from: diff.from, to: diff.to }, text: diff.text }); changed.add(id); }
    } else if (prior.block.type === "mathBlock" && current.block.type === "mathBlock") {
      const beforeCommandCount = commands.length;
      const priorRows = new Map(prior.block.rows.map((row) => [row.id, row]));
      const currentIds = current.block.rows.map((row) => row.id);
      const priorIds = prior.block.rows.map((row) => row.id);
      if (!sameOrder(priorIds, currentIds)) throw new Error("Math row reordering is not supported.");
      const removedRows = priorIds.filter((rowId) => !currentIds.includes(rowId));
      if (removedRows.length) commands.push({ type: "removeMathRows", nodeId: id, rowIds: removedRows });
      const available = new Set(priorIds.filter((rowId) => !removedRows.includes(rowId)));
      current.block.rows.forEach((row, index) => {
        if (!priorRows.has(row.id)) {
          const anchor = entityAnchor(currentIds, index, available);
          commands.push({ type: "insertMathRows", nodeId: id, anchor, rows: [structuredClone(row)] });
          available.add(row.id);
        } else if (priorRows.get(row.id)!.latex !== row.latex) {
          commands.push({ type: "setMathRow", nodeId: id, rowId: row.id, latex: row.latex });
        }
      });
      if (commands.length > beforeCommandCount) changed.add(id);
    } else if ("domain" in prior.block && "domain" in current.block && JSON.stringify(prior.block.domain) !== JSON.stringify(current.block.domain)) {
      commands.push({ type: "replaceDomain", nodeId: id, domain: structuredClone(current.block.domain) });
      changed.add(id);
    }
  }

  const available = new Set(was.keys());
  const insertedClone = (block: NmlBlock): NmlBlock => ({
    ...structuredClone(block),
    children: block.children.filter((child) => inserted.has(child.id)).map(insertedClone),
  }) as NmlBlock;
  [...next.values()].filter(({ block, parentId }) => inserted.has(block.id) && (parentId === null || !inserted.has(parentId)))
    .sort((left, right) => left.index - right.index)
    .forEach(({ block, parentId, index }) => {
      commands.push({ type: "insertNodes", parentId, anchor: anchorFor(after, parentId, index, available), nodes: [insertedClone(block)] });
      const add = (node: NmlBlock) => { available.add(node.id); changed.add(node.id); node.children.forEach(add); };
      add(block);
    });

  const wasRank = sharedRanks(was, next);
  const nextRank = sharedRanks(next, was);
  for (const [id, current] of next) {
    const prior = was.get(id);
    if (!prior || inserted.has(id)) continue;
    if (prior.parentId !== current.parentId || wasRank.get(id) !== nextRank.get(id)) {
      commands.push({
        type: "moveNodes",
        nodeIds: [id],
        destination: { parentId: current.parentId, anchor: anchorFor(after, current.parentId, current.index, available) },
      });
      changed.add(id);
    }
  }

  const removalRoots = [...was.values()].filter(({ block, parentId }) => removed.has(block.id) && (parentId === null || !removed.has(parentId)));
  if (removalRoots.length) {
    commands.push({ type: "removeNodes", nodeIds: removalRoots.map(({ block }) => block.id) });
    removalRoots.forEach(({ block }) => changed.add(block.id));
  }

  const beforeIds = collectIds(before);
  const temporaryIds = [...collectIds(after)].filter((id) => !beforeIds.has(id) && id.startsWith("$nml-"));
  return { commands, temporaryIds, changedNodeIds: [...changed], document: after };
}

export function translateProjectionTransaction(
  before: PmNode,
  after: PmNode,
  source: NmlDocument,
  projection: NmlProjection,
): NmlProjectionTranslation {
  if (!before.type.compatibleContent(after.type)) throw new Error("Foreign projection document.");
  const desired = projection.read(after, source);
  return compileProjectionChange(source, desired);
}
