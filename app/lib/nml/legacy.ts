import { parseHTML } from "linkedom";
import * as Y from "yjs";
import { parseAlbum } from "@/app/components/editor/album/parse";
import { parseLocation } from "@/app/components/editor/location/parse";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import {
  canvasMapName,
  hasCanvasState,
  materializeCanvas,
} from "@/app/components/editor/canvas/collab/ymap";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { isGroup, type Scene, type SceneNode } from "@/app/components/editor/canvas/scene/types";
import { normalizeDocument, normalizeInline } from "./normalize";
import {
  NML_MARKS,
  type NmlBlock,
  type NmlDocument,
  type NmlInline,
  type NmlInlineContent,
  type NmlIssue,
  type NmlListBlock,
  type NmlMark,
  type NmlMediaBlock,
  type NmlText,
} from "./schema";
import { validateDocument } from "./validate";
import { createNmlYDoc, type NmlTransactionOrigin } from "./yjs";

/**
 * Step 5 — legacy conversion and shadow NML.
 *
 * Converts the current live document representation into the canonical NML v1
 * AST, so the shadow can be built and compared while legacy remains the served
 * truth. The source of truth is BlockNote's block JSON (`editor.document`) — the
 * same denormalized tree the AI projection and applier read — NOT the AI's HTML
 * grammar, which has drifted from the canonical NML tags (`lang` vs `language`,
 * `page` vs `page-id`, `alt` vs `caption`, checklists as `<input>`); converting
 * the props directly is lossless where the HTML round-trip would not be. Custom
 * domains are decoded through their own owners (`migrateLegacyCanvas`,
 * `parseAlbum`/`parseStoryboard`/`parseLocation`), exactly as the canonical
 * parser does, so there is no second schema.
 *
 * Nothing here serves the shadow or mutates the live document: it is a headless
 * library that a later runtime stage will drive.
 */

/** A BlockNote block, kept structurally loose so this stays decoupled from the schema. */
export type LegacyBlock = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: LegacyBlock[];
};

export type LegacyDocumentInput = {
  documentId: string;
  blocks: LegacyBlock[];
};

export type LegacyConvertOptions = {
  /** Deterministic ID minter for entities BlockNote never gave one (inline embeds, table cells). */
  createId?: () => string;
  /** Node-compatible HTML parser for the custom-domain grammars. */
  parseHtml?: (html: string) => Document;
};

export type LegacyConversion = {
  document: NmlDocument;
  diagnostics: NmlIssue[];
};

const defaultParseHtml = (html: string): Document =>
  parseHTML(html).document as unknown as Document;

const defaultCreateId = () => {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("A cryptographically random createId function is required in this runtime.");
  return id;
};

/** BlockNote list/toggle blocks own their nested blocks; every other block flattens them. */
const NESTABLE = new Set(["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"]);

/** Block types with inline content the converter reads from `content`. */
const INLINE_BLOCKS = new Set([
  "paragraph",
  "quote",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function marksOf(styles: unknown): NmlMark[] {
  const s = record(styles);
  return NML_MARKS.filter((mark) => s[mark] === true);
}

/** True when a text run carries a colour/alignment BlockNote defaults omit. */
function hasDroppedStyle(styles: unknown): boolean {
  const s = record(styles);
  const kept = (value: unknown) => value !== undefined && value !== "default" && value !== "";
  return kept(s.textColor) || kept(s.backgroundColor);
}

type Ctx = {
  createId: () => string;
  parseHtml: (html: string) => Document;
  diagnostics: NmlIssue[];
  report: (code: string, severity: NmlIssue["severity"], path: Array<string | number>, message: string, nodeId?: string) => void;
};

function convertInline(content: unknown, path: Array<string | number>, ctx: Ctx): NmlInlineContent {
  if (!Array.isArray(content)) return [];
  const out: NmlInlineContent = [];
  content.forEach((raw, index) => {
    const item = record(raw);
    const here = [...path, index];
    switch (item.type) {
      case "text": {
        if (hasDroppedStyle(item.styles)) {
          ctx.report("legacy_dropped_style", "warning", here, "Inline text colour is not part of the canonical inline model and was dropped.");
        }
        out.push({ type: "text", text: str(item.text), marks: marksOf(item.styles) });
        break;
      }
      case "link": {
        const linked = (Array.isArray(item.content) ? item.content : [])
          .map((child) => record(child))
          .filter((child) => child.type === "text")
          .map((child) => ({ type: "text" as const, text: str(child.text), marks: marksOf(child.styles) }));
        out.push({ type: "link", href: str(item.href), content: linked });
        break;
      }
      case "math": {
        const id = ctx.createId();
        ctx.report("legacy_minted_id", "repair", here, `Inline math had no stable ID; minted "${id}".`, id);
        out.push({ type: "math", id, latex: str(record(item.props).latex) });
        break;
      }
      case "pageMention": {
        const id = ctx.createId();
        ctx.report("legacy_minted_id", "repair", here, `Page mention had no stable ID; minted "${id}".`, id);
        out.push({ type: "pageRef", id, pageId: str(record(item.props).pageId), fallbackTitle: str(record(item.props).title) });
        break;
      }
      default:
        ctx.report("legacy_dropped_inline", "warning", here, `Unsupported inline node <${str(item.type) || "unknown"}> was dropped.`);
    }
  });
  return out;
}

type LegacyTableContent = {
  headerRows?: number;
  columnWidths?: Array<number | null>;
  rows?: Array<{ cells?: unknown[] }>;
};

/** A table cell is a bare run list in what the applier writes, or a `tableCell` wrapper in what BlockNote stores. */
function cellRuns(cell: unknown): unknown {
  if (Array.isArray(cell)) return cell;
  return record(cell).content;
}

function convertBlock(block: LegacyBlock, path: Array<string | number>, ctx: Ctx): NmlBlock | null {
  const props = record(block.props);
  const id = block.id ?? (() => {
    const minted = ctx.createId();
    ctx.report("legacy_missing_block_id", "repair", path, `Block had no stable ID; minted "${minted}".`, minted);
    return minted;
  })();
  const content = () => convertInline(block.content, [...path, "content"], ctx);

  switch (block.type) {
    case "paragraph":
      return { id, type: "paragraph", props: {}, content: content(), children: [] };
    case "quote":
      return { id, type: "quote", props: {}, content: content(), children: [] };
    case "heading": {
      const raw = Number(props.level ?? 1);
      const level = (Math.min(6, Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : 1)) || 1) as 1 | 2 | 3 | 4 | 5 | 6;
      return { id, type: "heading", props: { level }, content: content(), children: [] };
    }
    case "bulletListItem":
      return { id, type: "bulletListItem", props: {}, content: content(), children: [] };
    case "checkListItem":
      return { id, type: "checkListItem", props: { checked: Boolean(props.checked) }, content: content(), children: [] };
    case "numberedListItem": {
      const start = Number(props.start);
      const props2: NmlListBlock["props"] = Number.isInteger(start) && start > 1 ? { start } : {};
      return { id, type: "numberedListItem", props: props2, content: content(), children: [] };
    }
    case "toggleListItem":
      return { id, type: "toggleListItem", props: {}, content: content(), children: [] };
    case "codeBlock":
      return { id, type: "codeBlock", props: { language: str(props.language) }, code: str(props.code), children: [] };
    case "mathBlock": {
      const source = str(props.source);
      const rows = source.length
        ? source.split("\n").map((latex) => {
            const rowId = ctx.createId();
            return { id: rowId, latex };
          })
        : [];
      if (rows.length) ctx.report("legacy_minted_id", "repair", path, "Math rows had no stable IDs; minted them.", id);
      return { id, type: "mathBlock", props: {}, rows, children: [] };
    }
    case "divider":
      return { id, type: "divider", props: {}, children: [] };
    case "image":
    case "video":
    case "audio":
    case "file": {
      const url = str(props.url).trim();
      const caption = str(props.caption);
      const name = str(props.name);
      const mediaProps: NmlMediaBlock["props"] = {
        ...(url ? { source: { kind: "url" as const, url } } : {}),
        ...(caption ? { caption } : {}),
        ...(name ? { name } : {}),
      };
      return { id, type: block.type as NmlMediaBlock["type"], props: mediaProps, children: [] };
    }
    case "table": {
      const table = (block.content ?? {}) as LegacyTableContent;
      const rowsInput = Array.isArray(table.rows) ? table.rows : [];
      const width = table.columnWidths?.length ?? rowsInput.reduce((max, row) => Math.max(max, row.cells?.length ?? 0), 0);
      const columns = Array.from({ length: width }, () => ({ id: ctx.createId() }));
      const rows = rowsInput.map((row, rowIndex) => {
        const cells = Array.isArray(row.cells) ? row.cells : [];
        if (cells.length !== width) {
          ctx.report("legacy_uneven_table", "warning", [...path, "rows", rowIndex], `Row had ${cells.length} cells; padded to ${width} stable columns.`, id);
        }
        return {
          id: ctx.createId(),
          cells: Array.from({ length: width }, (_, cellIndex) => ({
            id: ctx.createId(),
            content: convertInline(cellRuns(cells[cellIndex]), [...path, "rows", rowIndex, "cells", cellIndex], ctx),
          })),
        };
      });
      if (width) ctx.report("legacy_minted_id", "repair", path, "Table columns/rows/cells had no stable IDs; minted them.", id);
      return { id, type: "table", props: { headerRows: Math.min(Number(table.headerRows ?? 0) || 0, rows.length) }, columns, rows, children: [] };
    }
    case "canvas":
      return { id, type: "canvas", props: {}, scene: migrateLegacyCanvas(str(props.data), ctx.parseHtml), children: [] };
    case "album":
      return { id, type: "album", props: {}, domain: parseAlbum(str(props.data), ctx.parseHtml), children: [] };
    case "storyboard":
      return { id, type: "storyboard", props: {}, domain: parseStoryboard(str(props.data), ctx.parseHtml), children: [] };
    case "location":
      return { id, type: "location", props: {}, domain: parseLocation(str(props.data), ctx.parseHtml), children: [] };
    default:
      ctx.report("legacy_unsupported_block", "warning", path, `Block type <${block.type}> has no canonical NML v1 representation and was omitted from the shadow.`, id);
      return null;
  }
}

function convertBlocks(blocks: LegacyBlock[], path: Array<string | number>, ctx: Ctx): NmlBlock[] {
  const out: NmlBlock[] = [];
  blocks.forEach((block, index) => {
    const here = [...path, index];
    const converted = convertBlock(block, here, ctx);
    const children = block.children ?? [];
    if (converted && NESTABLE.has(converted.type)) {
      converted.children = convertBlocks(children, [...here, "children"], ctx);
      out.push(converted);
      return;
    }
    if (converted) out.push(converted);
    if (children.length) {
      if (converted) {
        ctx.report("legacy_flattened_children", "repair", here, `<${block.type}> cannot hold block children in NML; ${children.length} child block(s) were hoisted to siblings.`);
      }
      out.push(...convertBlocks(children, [...here, "children"], ctx));
    }
  });
  return out;
}

export function convertLegacyDocument(input: LegacyDocumentInput, options: LegacyConvertOptions = {}): LegacyConversion {
  const diagnostics: NmlIssue[] = [];
  const ctx: Ctx = {
    createId: options.createId ?? defaultCreateId,
    parseHtml: options.parseHtml ?? defaultParseHtml,
    diagnostics,
    report: (code, severity, path, message, nodeId) =>
      diagnostics.push({ code, severity, path, message, ...(nodeId ? { nodeId } : {}) }),
  };
  const blocks = convertBlocks(input.blocks, ["blocks"], ctx);
  const document = normalizeDocument({ schemaVersion: 1, documentId: input.documentId, blocks });
  diagnostics.push(...validateDocument(document));
  return { document, diagnostics };
}

// ---------------------------------------------------------------------------
// Shadow NML
// ---------------------------------------------------------------------------

export type LegacyShadow = LegacyConversion & { doc: Y.Doc | null };

/**
 * A non-serving canonical Y.Doc built from a legacy document. Returns `doc: null`
 * when conversion produced an error the encoder would reject, so callers can
 * still inspect the diagnostics rather than crashing.
 */
export function buildLegacyShadow(
  input: LegacyDocumentInput,
  options: LegacyConvertOptions = {},
  origin?: NmlTransactionOrigin,
): LegacyShadow {
  const { document, diagnostics } = convertLegacyDocument(input, options);
  const blocked = diagnostics.some((issue) => issue.severity === "error");
  return { document, diagnostics, doc: blocked ? null : createNmlYDoc(document, origin) };
}

// ---------------------------------------------------------------------------
// Canvas map/HTML pair
// ---------------------------------------------------------------------------

/** The scene as the served `<nt-diagram>` block-prop mirror materializes it. */
export function canvasSceneFromMirror(data: string, parseHtml: (html: string) => Document = defaultParseHtml): Scene {
  return migrateLegacyCanvas(data, parseHtml);
}

/** The scene as the live per-shape CRDT maps materialize it, or null when the block has no map state yet. */
export function canvasSceneFromMaps(doc: Y.Doc, blockId: string): Scene | null {
  const root = doc.getMap<unknown>(canvasMapName(blockId)) as Y.Map<unknown>;
  return hasCanvasState(root) ? materializeCanvas(root) : null;
}

export type SceneMismatch = { class: string; id?: string; detail: string };

function flattenScene(scene: Scene): { nodes: Map<string, { parentId: string | null; fields: string }>; edges: Map<string, string> } {
  const nodes = new Map<string, { parentId: string | null; fields: string }>();
  const walk = (list: readonly SceneNode[], parentId: string | null) => {
    for (const node of list) {
      const { children: _children, ...fields } = node as SceneNode & { children?: SceneNode[] };
      nodes.set(node.id, { parentId, fields: stableStringify(fields) });
      if (isGroup(node)) walk(node.children, node.id);
    }
  };
  walk(scene.nodes, null);
  const edges = new Map(scene.edges.map((edge) => [edge.id, stableStringify(edge)]));
  return { nodes, edges };
}

/** Structural equivalence of two materialized scenes; empty when they agree. */
export function compareScenes(a: Scene, b: Scene): SceneMismatch[] {
  const out: SceneMismatch[] = [];
  if (a.w !== b.w || a.h !== b.h) out.push({ class: "canvas-size", detail: `size ${a.w}x${a.h} vs ${b.w}x${b.h}` });
  if (stableStringify(a.style) !== stableStringify(b.style)) out.push({ class: "canvas-style", detail: "root style differs" });
  if (stableStringify(a.attrs) !== stableStringify(b.attrs)) out.push({ class: "canvas-attrs", detail: "root attrs differ" });
  const left = flattenScene(a);
  const right = flattenScene(b);
  for (const [id, node] of left.nodes) {
    const other = right.nodes.get(id);
    if (!other) out.push({ class: "canvas-shape-missing", id, detail: "shape only in first scene" });
    else if (other.parentId !== node.parentId) out.push({ class: "canvas-shape-parent", id, detail: `parent ${node.parentId} vs ${other.parentId}` });
    else if (other.fields !== node.fields) out.push({ class: "canvas-shape-fields", id, detail: "shape fields differ" });
  }
  for (const id of right.nodes.keys()) if (!left.nodes.has(id)) out.push({ class: "canvas-shape-added", id, detail: "shape only in second scene" });
  for (const [id, edge] of left.edges) {
    const other = right.edges.get(id);
    if (!other) out.push({ class: "canvas-edge-missing", id, detail: "edge only in first scene" });
    else if (other !== edge) out.push({ class: "canvas-edge-fields", id, detail: "edge fields differ" });
  }
  for (const id of right.edges.keys()) if (!left.edges.has(id)) out.push({ class: "canvas-edge-added", id, detail: "edge only in second scene" });
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Legacy ↔ NML comparison
// ---------------------------------------------------------------------------

/**
 * Conversion diagnostic codes that are known, explained transformations rather
 * than data loss the shadow cannot tolerate. The step-5 gate is not "zero
 * diagnostics" but "every diagnostic is one of these understood classes".
 */
export const UNDERSTOOD_LEGACY_CODES = new Set([
  "legacy_minted_id",
  "legacy_missing_block_id",
  "legacy_dropped_style",
  "legacy_dropped_inline",
  "legacy_flattened_children",
  "legacy_uneven_table",
  "legacy_unsupported_block",
]);

/**
 * Comparison mismatch classes that are acceptable: a block type NML v1 cannot
 * represent is a known gap while legacy keeps serving it. Every other class
 * (a diverged parent, type, inline run, or canvas scene, or a fabricated or
 * duplicated block) means the shadow is not faithful and is a converter bug.
 */
export const UNDERSTOOD_MISMATCH_CLASSES = new Set(["unsupported-block"]);

export type LegacyMismatch = { class: string; id?: string; detail: string; understood: boolean };
export type LegacyComparison = { ok: boolean; mismatches: LegacyMismatch[] };

type StructRow = { id: string; type: string; parentId: string | null };

/** Expected NML structure derived independently from the raw legacy tree, applying the hoist rule. */
function legacyStructure(blocks: LegacyBlock[], parentId: string | null, out: StructRow[]): void {
  for (const block of blocks) {
    const supported = NML_BLOCK_TYPES.has(block.type);
    const nestable = NESTABLE.has(block.type);
    if (supported && block.id) out.push({ id: block.id, type: block.type, parentId });
    if (block.children?.length) {
      legacyStructure(block.children, supported && nestable && block.id ? block.id : parentId, out);
    }
  }
}

function nmlStructure(blocks: NmlBlock[], parentId: string | null, out: StructRow[]): void {
  for (const block of blocks) {
    out.push({ id: block.id, type: block.type, parentId });
    if (block.children.length) nmlStructure(block.children, block.id, out);
  }
}

/** Inline stripped of minted IDs so an embed compares by content, not identity. */
function comparableInline(content: NmlInlineContent): string {
  return stableStringify(
    normalizeInline(content).map((node: NmlInline) => {
      if (node.type === "math") return { k: "math", latex: node.latex };
      if (node.type === "pageRef") return { k: "ref", pageId: node.pageId, title: node.fallbackTitle };
      if (node.type === "link") return { k: "link", href: node.href, content: node.content.map((t: NmlText) => ({ text: t.text, marks: t.marks })) };
      return { k: "text", text: node.text, marks: node.marks };
    }),
  );
}

/** Block types the canonical NML v1 AST can represent. */
const NML_BLOCK_TYPES = new Set([
  "paragraph",
  "quote",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "table",
  "codeBlock",
  "mathBlock",
  "divider",
  "image",
  "video",
  "audio",
  "file",
  "canvas",
  "album",
  "storyboard",
  "location",
]);

/**
 * Compares a legacy document to its converted NML AST across structure, IDs,
 * inline semantics and materialized canvas scenes, classifying every mismatch.
 * The inline/scene checks re-derive expectations from the raw legacy props on a
 * separate code path from the converter, so a mark or scene bug shows up here.
 */
export function compareLegacyToNml(
  input: LegacyDocumentInput,
  document: NmlDocument,
  options: LegacyConvertOptions = {},
): LegacyComparison {
  const parseHtml = options.parseHtml ?? defaultParseHtml;
  const mismatches: LegacyMismatch[] = [];
  const add = (mismatch: Omit<LegacyMismatch, "understood">) =>
    mismatches.push({ ...mismatch, understood: UNDERSTOOD_MISMATCH_CLASSES.has(mismatch.class) });

  // Blocks NML v1 cannot represent — a known gap while legacy keeps serving them.
  const flagUnsupported = (blocks: LegacyBlock[]) => {
    for (const block of blocks) {
      if (!NML_BLOCK_TYPES.has(block.type)) {
        add({ class: "unsupported-block", id: block.id, detail: `legacy <${block.type}> has no NML v1 representation` });
      }
      if (block.children?.length) flagUnsupported(block.children);
    }
  };
  flagUnsupported(input.blocks);

  // Structure and identity.
  const expected: StructRow[] = [];
  legacyStructure(input.blocks, null, expected);
  const actual: StructRow[] = [];
  nmlStructure(document.blocks, null, actual);
  const expectedIds = new Set(expected.map((row) => row.id));
  const actualById = new Map(actual.map((row) => [row.id, row]));
  for (const row of expected) {
    const got = actualById.get(row.id);
    if (!got) {
      add({ class: "unsupported-block", id: row.id, detail: `legacy <${row.type}> absent from NML` });
    } else if (got.type !== row.type) {
      add({ class: "block-type", id: row.id, detail: `type ${row.type} vs ${got.type}` });
    } else if (got.parentId !== row.parentId) {
      add({ class: "block-parent", id: row.id, detail: `parent ${row.parentId} vs ${got.parentId}` });
    }
  }
  for (const row of actual) {
    if (!expectedIds.has(row.id)) add({ class: "fabricated-block", id: row.id, detail: `NML <${row.type}> has no legacy source` });
  }
  if (actual.length !== new Set(actual.map((row) => row.id)).size) add({ class: "duplicate-id", detail: "NML contains duplicate IDs" });

  // Inline semantics and canvas scenes, joined by stable block ID.
  const legacyById = new Map<string, LegacyBlock>();
  const indexLegacy = (blocks: LegacyBlock[]) => {
    for (const block of blocks) {
      if (block.id) legacyById.set(block.id, block);
      if (block.children?.length) indexLegacy(block.children);
    }
  };
  indexLegacy(input.blocks);

  const nmlById = new Map<string, NmlBlock>();
  const indexNml = (blocks: NmlBlock[]) => {
    for (const block of blocks) {
      nmlById.set(block.id, block);
      if (block.children.length) indexNml(block.children);
    }
  };
  indexNml(document.blocks);

  for (const [id, nml] of nmlById) {
    const legacy = legacyById.get(id);
    if (!legacy) continue;
    if (INLINE_BLOCKS.has(nml.type) && "content" in nml) {
      const expectedInline = comparableInline(convertInlineExpectation(legacy.content));
      if (comparableInline(nml.content) !== expectedInline) {
        add({ class: "inline-semantics", id, detail: `inline content diverged for <${nml.type}>` });
      }
    }
    if (nml.type === "canvas") {
      const scene = migrateLegacyCanvas(str(record(legacy.props).data), parseHtml);
      const diff = compareScenes(scene, nml.scene);
      for (const d of diff) add({ class: "canvas-scene", id, detail: `${d.class}${d.id ? ` ${d.id}` : ""}: ${d.detail}` });
    }
  }

  return { ok: mismatches.every((mismatch) => mismatch.understood), mismatches };
}

/**
 * Re-derives the expected NML inline from raw BlockNote inline on a code path
 * independent of the converter: marks read straight off the style booleans,
 * embeds compared by content only. Minted IDs are placeholders (stripped before
 * comparison), so this never depends on the converter's ID choices.
 */
function convertInlineExpectation(content: unknown): NmlInlineContent {
  if (!Array.isArray(content)) return [];
  const out: NmlInlineContent = [];
  for (const raw of content) {
    const item = record(raw);
    if (item.type === "text") out.push({ type: "text", text: str(item.text), marks: NML_MARKS.filter((m) => record(item.styles)[m] === true) });
    else if (item.type === "link") {
      const linked = (Array.isArray(item.content) ? item.content : [])
        .map(record)
        .filter((c) => c.type === "text")
        .map((c) => ({ type: "text" as const, text: str(c.text), marks: NML_MARKS.filter((m) => record(c.styles)[m] === true) }));
      out.push({ type: "link", href: str(item.href), content: linked });
    } else if (item.type === "math") out.push({ type: "math", id: "_", latex: str(record(item.props).latex) });
    else if (item.type === "pageMention") out.push({ type: "pageRef", id: "_", pageId: str(record(item.props).pageId), fallbackTitle: str(record(item.props).title) });
  }
  return out;
}
