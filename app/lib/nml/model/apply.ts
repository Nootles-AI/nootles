import type { ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { parseAlbum } from "@/app/components/editor/album/parse";
import { parseLocation } from "@/app/components/editor/location/parse";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import type {
  Batch,
  BlockProps,
  InlineRun,
  NewBlock,
  Operation,
  Position,
} from "@/convex/ai/operations";
import {
  executeNmlCommands,
  type ExecuteNmlCommandsOptions,
  type NmlCommand,
  type NmlCommandReceipt,
} from "../commands";
import type {
  NmlBlock,
  NmlDocument,
  NmlInlineContent,
  NmlTableBlock,
} from "../schema";
import { decodeNmlDocument } from "../yjs";
import { compileCanvasSceneChange } from "../view/canvas";
import { isEmptyParagraphBlock } from "@/app/lib/documentTail";

/** A model batch was valid at the public operation layer but cannot exist in NML v1. */
export class NmlBatchCompileError extends Error {
  constructor(message: string, readonly operationIndex?: number) {
    super(message);
    this.name = "NmlBatchCompileError";
  }
}

export type CompiledNmlBatch = {
  commands: NmlCommand[];
  temporaryIds: string[];
  changedNodeIds: string[];
};

export type CompileNmlBatchOptions = {
  parseHtml?: ParseHtml;
};

type LocatedBlock = {
  block: NmlBlock;
  parentId: string | null;
  siblings: NmlBlock[];
  index: number;
};

function locate(document: NmlDocument, id: string): LocatedBlock | null {
  const visit = (siblings: NmlBlock[], parentId: string | null): LocatedBlock | null => {
    for (let index = 0; index < siblings.length; index++) {
      const block = siblings[index];
      if (block.id === id) return { block, parentId, siblings, index };
      const nested = visit(block.children, block.id);
      if (nested) return nested;
    }
    return null;
  };
  return visit(document.blocks, null);
}

function inlineLength(content: NmlInlineContent): number {
  return content.reduce(
    (total, node) =>
      total +
      (node.type === "text"
        ? node.text.length
        : node.type === "link"
          ? inlineLength(node.content)
          : 1),
    0,
  );
}

function stringProp(props: BlockProps | undefined, key: string): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

function numberProp(props: BlockProps | undefined, key: string): number | undefined {
  const value = props?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanProp(props: BlockProps | undefined, key: string): boolean | undefined {
  const value = props?.[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Compile the model's stable-ID operation vocabulary into the canonical NML
 * command vocabulary. The returned commands are still pure data: callers may
 * stage, authorize, or execute the whole batch without a BlockNote editor.
 */
export function compileNmlBatch(
  document: NmlDocument,
  batch: Batch,
  options: CompileNmlBatchOptions = {},
): CompiledNmlBatch {
  const working = structuredClone(document);
  const commands: NmlCommand[] = [];
  const temporaryIds: string[] = [];
  const changed = new Set<string>();
  const known = new Set<string>();
  const collectKnown = (blocks: NmlBlock[]) => {
    for (const block of blocks) {
      known.add(block.id);
      collectKnown(block.children);
    }
  };
  collectKnown(working.blocks);
  let generated = 0;
  const temporary = (kind: string, requested?: string): string => {
    let id = requested;
    if (!id) {
      do id = `$nml-${kind}-${++generated}`;
      while (known.has(id));
    }
    if (known.has(id)) throw new NmlBatchCompileError(`Duplicate block or temporary ID ${id}.`);
    known.add(id);
    temporaryIds.push(id);
    return id;
  };

  const inline = (runs: InlineRun[] | undefined): NmlInlineContent =>
    (runs ?? []).map((run) => {
      switch (run.type) {
        case "text":
          return { type: "text" as const, text: run.text, marks: [...(run.marks ?? [])] };
        case "link":
          return {
            type: "link" as const,
            href: run.href,
            content: run.content.map((text) => ({
              type: "text" as const,
              text: text.text,
              marks: [...(text.marks ?? [])],
            })),
          };
        case "math":
          return { type: "math" as const, id: temporary("inline-math"), latex: run.latex };
        case "pageRef":
          return {
            type: "pageRef" as const,
            id: temporary("page-ref"),
            pageId: run.pageId,
            fallbackTitle: run.title,
          };
        case "checkbox":
          return { type: "checkbox" as const, id: temporary("checkbox"), checked: run.checked };
      }
    });

  const block = (input: NewBlock): NmlBlock => {
    const id = temporary("block", input.tempId);
    const children = (input.children ?? []).map(block);
    const leaf = () => {
      if (children.length) {
        throw new NmlBatchCompileError(`${input.type} cannot contain child blocks in NML v1.`);
      }
      return children;
    };
    switch (input.type) {
      case "paragraph":
      case "quote":
        return { id, type: input.type, props: {}, content: inline(input.content), children: leaf() };
      case "heading": {
        const requested = Math.trunc(numberProp(input.props, "level") ?? 1);
        const level = Math.min(6, Math.max(1, requested)) as 1 | 2 | 3 | 4 | 5 | 6;
        return { id, type: "heading", props: { level }, content: inline(input.content), children: leaf() };
      }
      case "bulletListItem":
      case "toggleListItem":
        return { id, type: input.type, props: {}, content: inline(input.content), children };
      case "checkListItem":
        return {
          id,
          type: "checkListItem",
          props: { checked: booleanProp(input.props, "checked") ?? false },
          content: inline(input.content),
          children,
        };
      case "numberedListItem": {
        const start = Math.trunc(numberProp(input.props, "start") ?? 1);
        return {
          id,
          type: "numberedListItem",
          props: start > 1 ? { start } : {},
          content: inline(input.content),
          children,
        };
      }
      case "table": {
        const rows = input.rows ?? [];
        const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
        const columns = Array.from({ length: width }, () => ({ id: temporary("table-column") }));
        return {
          id,
          type: "table",
          props: { headerRows: Math.min(input.headerRows ?? 0, rows.length) },
          columns,
          rows: rows.map((row) => ({
            id: temporary("table-row"),
            cells: Array.from({ length: width }, (_, cell) => ({
              id: temporary("table-cell"),
              content: inline(row[cell] ?? []),
            })),
          })),
          children: leaf(),
        };
      }
      case "codeBlock":
        return {
          id,
          type: "codeBlock",
          props: { language: stringProp(input.props, "language") },
          code: stringProp(input.props, "code"),
          children: leaf(),
        };
      case "mathBlock": {
        const source = stringProp(input.props, "source");
        return {
          id,
          type: "mathBlock",
          props: {},
          rows: source ? source.split("\n").map((latex) => ({ id: temporary("math-row"), latex })) : [],
          children: leaf(),
        };
      }
      case "divider":
        return { id, type: "divider", props: {}, children: leaf() };
      case "image":
      case "video":
      case "audio":
      case "file": {
        const url = stringProp(input.props, "url").trim();
        const caption = stringProp(input.props, "caption");
        const name = stringProp(input.props, "name");
        return {
          id,
          type: input.type,
          props: {
            ...(url ? { source: { kind: "url" as const, url } } : {}),
            ...(caption ? { caption } : {}),
            ...(name ? { name } : {}),
          },
          children: leaf(),
        };
      }
      case "canvas":
        return {
          id,
          type: "canvas",
          props: {},
          scene: { ...migrateLegacyCanvas(stringProp(input.props, "data"), options.parseHtml), id },
          children: leaf(),
        };
      case "album":
        return {
          id,
          type: "album",
          props: {},
          domain: { ...parseAlbum(stringProp(input.props, "data"), options.parseHtml), id },
          children: leaf(),
        };
      case "storyboard":
        return {
          id,
          type: "storyboard",
          props: {},
          domain: { ...parseStoryboard(stringProp(input.props, "data"), options.parseHtml), id },
          children: leaf(),
        };
      case "location":
        return {
          id,
          type: "location",
          props: {},
          domain: { ...parseLocation(stringProp(input.props, "data"), options.parseHtml), id },
          children: leaf(),
        };
      case "notionStub":
        return {
          id,
          type: "notionStub",
          props: {
            notionType: stringProp(input.props, "notionType"),
            notionId: stringProp(input.props, "notionId"),
            href: stringProp(input.props, "href"),
            raw: stringProp(input.props, "raw"),
          },
          children: leaf(),
        };
    }
  };

  const placement = (position: Position): { parentId: string | null; anchor?: { beforeId?: string; afterId?: string } } => {
    if (position.at === "docStart") {
      return { parentId: null, ...(working.blocks[0] ? { anchor: { beforeId: working.blocks[0].id } } : {}) };
    }
    if (position.at === "docEnd") {
      const last = working.blocks.at(-1);
      return {
        parentId: null,
        ...(last
          ? {
              anchor: isEmptyParagraphBlock(last)
                ? { beforeId: last.id }
                : { afterId: last.id },
            }
          : {}),
      };
    }
    const reference = locate(working, position.ref);
    if (!reference) throw new NmlBatchCompileError(`Unknown position reference ${position.ref}.`);
    const isProtectedTail =
      position.at === "after" &&
      reference.parentId === null &&
      working.blocks.at(-1)?.id === reference.block.id &&
      isEmptyParagraphBlock(reference.block);
    return {
      parentId: reference.parentId,
      anchor:
        position.at === "before" || isProtectedTail
          ? { beforeId: position.ref }
          : { afterId: position.ref },
    };
  };

  const insertWorking = (nodes: NmlBlock[], destination: ReturnType<typeof placement>) => {
    const siblings = destination.parentId === null
      ? working.blocks
      : locate(working, destination.parentId)?.block.children;
    if (!siblings) throw new NmlBatchCompileError(`Unknown parent ${destination.parentId}.`);
    const reference = destination.anchor?.beforeId ?? destination.anchor?.afterId;
    const found = reference ? siblings.findIndex((candidate) => candidate.id === reference) : -1;
    const index = found < 0 ? siblings.length : destination.anchor?.afterId ? found + 1 : found;
    siblings.splice(index, 0, ...nodes);
  };

  const compileTable = (table: NmlTableBlock, op: Extract<Operation, { kind: "setTableRows" }>) => {
    const desiredRows = op.rows.length;
    const desiredColumns = op.rows.reduce((max, row) => Math.max(max, row.length), 0);
    const desiredContent = Array.from({ length: desiredRows }, (_, row) =>
      Array.from({ length: desiredColumns }, (_, column) => inline(op.rows[row]?.[column] ?? [])),
    );
    const rowIds = Array.from({ length: desiredRows }, (_, row) => table.rows[row]?.id ?? temporary("table-row"));
    const columnIds = Array.from({ length: desiredColumns }, (_, column) => table.columns[column]?.id ?? temporary("table-column"));
    const cellIds = Array.from({ length: desiredRows }, (_, row) =>
      Array.from({ length: desiredColumns }, (_, column) =>
        table.rows[row]?.cells[column]?.id ?? temporary("table-cell"),
      ),
    );

    if (desiredRows > table.rows.length) {
      commands.push({
        type: "insertTableRows",
        tableId: table.id,
        ...(table.rows.at(-1) ? { anchor: { afterId: table.rows.at(-1)!.id } } : {}),
        rows: rowIds.slice(table.rows.length).map((id, offset) => {
          const row = table.rows.length + offset;
          return {
            id,
            cells: table.columns.map((_, column) => ({
              id: cellIds[row]?.[column] ?? temporary("table-cell"),
              content: structuredClone(desiredContent[row]?.[column] ?? []),
            })),
          };
        }),
      });
    }
    if (desiredColumns > table.columns.length) {
      const allRowIds = [
        ...table.rows.map((row) => row.id),
        ...rowIds.slice(table.rows.length),
      ];
      commands.push({
        type: "insertTableColumns",
        tableId: table.id,
        ...(table.columns.at(-1) ? { anchor: { afterId: table.columns.at(-1)!.id } } : {}),
        columns: columnIds.slice(table.columns.length).map((id, offset) => {
          const column = table.columns.length + offset;
          return {
            id,
            cells: allRowIds.map((rowId, row) => ({
              rowId,
              cell: {
                id: cellIds[row]?.[column] ?? temporary("table-cell"),
                content: structuredClone(desiredContent[row]?.[column] ?? []),
              },
            })),
          };
        }),
      });
    }
    if (desiredRows < table.rows.length) {
      commands.push({ type: "removeTableRows", tableId: table.id, rowIds: table.rows.slice(desiredRows).map((row) => row.id) });
    }
    if (desiredColumns < table.columns.length) {
      commands.push({ type: "removeTableColumns", tableId: table.id, columnIds: table.columns.slice(desiredColumns).map((column) => column.id) });
    }
    if (desiredRows && desiredColumns) {
      commands.push({
        type: "replaceTableRange",
        tableId: table.id,
        rowIds,
        columnIds,
        cells: rowIds.map((_, row) =>
          columnIds.map((__, column) => ({
            id: cellIds[row][column],
            content: structuredClone(desiredContent[row][column]),
          })),
        ),
      });
    }
    commands.push({
      type: "setNodeProps",
      nodeId: table.id,
      patch: { headerRows: Math.min(op.headerRows ?? 0, desiredRows) },
    });
    table.columns = columnIds.map((id) => ({ id }));
    table.rows = rowIds.map((id, row) => ({
      id,
      cells: columnIds.map((_, column) => ({
        id: cellIds[row][column],
        content: structuredClone(desiredContent[row][column]),
      })),
    }));
    table.props.headerRows = Math.min(op.headerRows ?? 0, desiredRows);
  };

  const updateProps = (target: NmlBlock, props: BlockProps) => {
    switch (target.type) {
      case "canvas": {
        if (typeof props.data !== "string") return;
        const next = { ...migrateLegacyCanvas(props.data, options.parseHtml), id: target.id };
        commands.push(...compileCanvasSceneChange(target.id, target.scene, next).commands);
        target.scene = next;
        return;
      }
      case "album":
        if (typeof props.data === "string") {
          target.domain = { ...parseAlbum(props.data, options.parseHtml), id: target.id };
          commands.push({ type: "replaceDomain", nodeId: target.id, domain: target.domain });
        }
        return;
      case "storyboard":
        if (typeof props.data === "string") {
          target.domain = { ...parseStoryboard(props.data, options.parseHtml), id: target.id };
          commands.push({ type: "replaceDomain", nodeId: target.id, domain: target.domain });
        }
        return;
      case "location":
        if (typeof props.data === "string") {
          target.domain = { ...parseLocation(props.data, options.parseHtml), id: target.id };
          commands.push({ type: "replaceDomain", nodeId: target.id, domain: target.domain });
        }
        return;
      case "codeBlock": {
        const patch: Record<string, unknown> = {};
        if (typeof props.language === "string") {
          patch.language = props.language;
          target.props.language = props.language;
        }
        if (typeof props.code === "string" && props.code !== target.code) {
          commands.push({ type: "setCode", nodeId: target.id, range: { from: 0, to: target.code.length }, text: props.code });
          target.code = props.code;
        }
        if (Object.keys(patch).length) commands.push({ type: "setNodeProps", nodeId: target.id, patch });
        return;
      }
      case "mathBlock": {
        if (typeof props.source !== "string") return;
        const rows = props.source ? props.source.split("\n") : [];
        const nextRows = rows.map((latex, row) => ({
          id: target.rows[row]?.id ?? temporary("math-row"),
          latex,
        }));
        const shared = Math.min(rows.length, target.rows.length);
        for (let row = 0; row < shared; row++) {
          if (rows[row] !== target.rows[row].latex) {
            commands.push({ type: "setMathRow", nodeId: target.id, rowId: target.rows[row].id, latex: rows[row] });
          }
        }
        if (rows.length > target.rows.length) {
          const inserted = nextRows.slice(target.rows.length);
          commands.push({
            type: "insertMathRows",
            nodeId: target.id,
            ...(target.rows.at(-1) ? { anchor: { afterId: target.rows.at(-1)!.id } } : {}),
            rows: inserted,
          });
        }
        if (rows.length < target.rows.length) {
          commands.push({ type: "removeMathRows", nodeId: target.id, rowIds: target.rows.slice(rows.length).map((row) => row.id) });
        }
        target.rows = nextRows;
        return;
      }
      case "image":
      case "video":
      case "audio":
      case "file": {
        const patch: Record<string, unknown | undefined> = {};
        if (typeof props.url === "string") {
          patch.source = props.url.trim() ? { kind: "url", url: props.url.trim() } : undefined;
        }
        if (typeof props.caption === "string") patch.caption = props.caption || undefined;
        if (typeof props.name === "string") patch.name = props.name || undefined;
        if (Object.keys(patch).length) {
          commands.push({ type: "setNodeProps", nodeId: target.id, patch });
          Object.assign(target.props, patch);
        }
        return;
      }
      case "heading":
        if (typeof props.level === "number") {
          const level = Math.min(6, Math.max(1, Math.trunc(props.level))) as 1 | 2 | 3 | 4 | 5 | 6;
          target.props.level = level;
          commands.push({ type: "setNodeProps", nodeId: target.id, patch: { level } });
        }
        return;
      case "checkListItem":
        if (typeof props.checked === "boolean") {
          target.props.checked = props.checked;
          commands.push({ type: "setNodeProps", nodeId: target.id, patch: { checked: props.checked } });
        }
        return;
      case "numberedListItem":
        if (typeof props.start === "number") {
          const start = Math.max(1, Math.trunc(props.start));
          target.props.start = start;
          commands.push({ type: "setNodeProps", nodeId: target.id, patch: { start } });
        }
        return;
      default:
        return;
    }
  };

  batch.ops.forEach((op, operationIndex) => {
    try {
      switch (op.kind) {
        case "insertBlocks": {
          const destination = placement(op.at);
          const nodes = op.blocks.map(block);
          commands.push({ type: "insertNodes", parentId: destination.parentId, ...(destination.anchor ? { anchor: destination.anchor } : {}), nodes });
          insertWorking(nodes, destination);
          nodes.forEach((node) => changed.add(node.id));
          return;
        }
        case "updateBlockProps": {
          const found = locate(working, op.blockId);
          if (!found) throw new NmlBatchCompileError(`Unknown block ${op.blockId}.`);
          updateProps(found.block, op.props);
          changed.add(found.block.id);
          return;
        }
        case "setBlockContent": {
          const found = locate(working, op.blockId);
          if (!found || !("content" in found.block)) throw new NmlBatchCompileError(`Block ${op.blockId} has no inline content.`);
          const content = inline(op.content);
          commands.push({ type: "replaceInline", nodeId: found.block.id, range: { from: 0, to: inlineLength(found.block.content) }, content });
          found.block.content = content;
          changed.add(found.block.id);
          return;
        }
        case "setTableRows": {
          const found = locate(working, op.blockId);
          if (!found || found.block.type !== "table") throw new NmlBatchCompileError(`Block ${op.blockId} is not a table.`);
          compileTable(found.block, op);
          changed.add(found.block.id);
          return;
        }
        case "moveBlock": {
          const found = locate(working, op.blockId);
          if (!found) throw new NmlBatchCompileError(`Unknown block ${op.blockId}.`);
          if ((op.to.at === "before" || op.to.at === "after") && op.to.ref === found.block.id) return;
          const destination = placement(op.to);
          if (destination.parentId === found.block.id) throw new NmlBatchCompileError("A block cannot move into itself.");
          found.siblings.splice(found.index, 1);
          insertWorking([found.block], destination);
          commands.push({ type: "moveNodes", nodeIds: [found.block.id], destination });
          changed.add(found.block.id);
          return;
        }
        case "removeBlock": {
          const found = locate(working, op.blockId);
          if (!found) throw new NmlBatchCompileError(`Unknown block ${op.blockId}.`);
          found.siblings.splice(found.index, 1);
          commands.push({ type: "removeNodes", nodeIds: [found.block.id] });
          changed.add(found.block.id);
          return;
        }
        case "setMathRows": {
          const found = locate(working, op.blockId);
          if (!found || found.block.type !== "mathBlock") throw new NmlBatchCompileError(`Block ${op.blockId} is not a math block.`);
          updateProps(found.block, { source: op.rows.join("\n") });
          changed.add(found.block.id);
          return;
        }
        case "updateMathRow": {
          const found = locate(working, op.blockId);
          if (!found || found.block.type !== "mathBlock" || !found.block.rows[op.rowIndex]) {
            throw new NmlBatchCompileError(`Math row ${op.rowIndex} does not exist on ${op.blockId}.`);
          }
          const row = found.block.rows[op.rowIndex];
          commands.push({ type: "setMathRow", nodeId: found.block.id, rowId: row.id, latex: op.latex });
          row.latex = op.latex;
          changed.add(found.block.id);
          return;
        }
      }
    } catch (error) {
      if (error instanceof NmlBatchCompileError && error.operationIndex === undefined) {
        throw new NmlBatchCompileError(error.message, operationIndex);
      }
      throw error;
    }
  });

  return {
    commands,
    temporaryIds: [...new Set(temporaryIds)],
    changedNodeIds: [...changed],
  };
}

export type ApplyNmlBatchOptions = Omit<
  ExecuteNmlCommandsOptions,
  "commands" | "temporaryIds" | "documentId"
> & {
  batch: Batch;
  parseHtml?: ParseHtml;
};

export type ApplyNmlBatchResult = CompiledNmlBatch & {
  receipt: NmlCommandReceipt;
  before: NmlDocument;
  after: NmlDocument;
};

/** Authorize and land one model/MCP batch as one attributed NML transaction. */
export async function applyNmlBatch(options: ApplyNmlBatchOptions): Promise<ApplyNmlBatchResult> {
  const before = decodeNmlDocument(options.doc);
  const compiled = compileNmlBatch(before, options.batch, { parseHtml: options.parseHtml });
  const receipt = await executeNmlCommands({
    ...options,
    documentId: before.documentId,
    commands: compiled.commands,
    temporaryIds: compiled.temporaryIds,
  });
  return { ...compiled, receipt, before, after: decodeNmlDocument(options.doc) };
}
