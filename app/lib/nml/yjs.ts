import * as Y from "yjs";
import { keyForIndex } from "@/app/components/editor/canvas/collab/order";
import type { Scene, SceneEdge, SceneNode } from "@/app/components/editor/canvas/scene/types";
import { normalizeDocument } from "./normalize";
import {
  NML_LIMITS,
  NML_MARKS,
  nmlDocumentSchema,
  type NmlBlock,
  type NmlDocument,
  type NmlInlineContent,
  type NmlIssue,
  type NmlMark,
} from "./schema";

export const NML_YJS_ROOT = "nml";
export const NML_YJS_ENCODING_VERSION = 1 as const;
export const NML_YJS_STRUCTURE_KEY = "structure";

/**
 * A row and column can be inserted on disconnected replicas, so neither command can
 * supply their intersection cell. The decoded table exposes that otherwise-missing
 * intersection through a deterministic identity; the next edit materializes it in Yjs.
 */
export function nmlTableIntersectionCellId(tableId: string, rowId: string, columnId: string): string {
  return `$nml-table-cell-${JSON.stringify([tableId, rowId, columnId])}`;
}

export type NmlTransactionOrigin = {
  version: 1;
  transactionId: string;
  actor: {
    userId: string;
    kind: "human" | "model" | "system";
    clientId?: string;
  };
  command: string;
  requestId?: string;
  batchId?: string;
};

export type NmlChange =
  | { kind: "text"; nodeId: string; range?: NmlTextChangeRange }
  | { kind: "props"; nodeId: string; keys: string[] }
  | { kind: "insert"; parentId: string | null; nodeIds: string[] }
  | { kind: "remove"; parentId: string | null; nodeIds: string[] }
  | { kind: "move"; nodeId: string; fromParentId: string | null; toParentId: string | null }
  | { kind: "replaceDomain"; nodeId: string; domain: string };

export type NmlChangeSet = {
  transactionId?: string;
  origin: NmlTransactionOrigin | null;
  beforeStateVector: Uint8Array;
  afterStateVector: Uint8Array;
  changes: NmlChange[];
  diagnostics: NmlIssue[];
  /** Present on validated full-path observations so readers need not decode twice. */
  document?: NmlDocument;
};

export type NmlTextChangeRange = {
  /** UTF-16 offsets in the text before the transaction. */
  from: number;
  to: number;
  insertedLength: number;
};

export type NmlPlainTextTarget = {
  nodeId: string;
  type: "paragraph" | "heading" | "quote";
  text: string;
  fragment: Y.XmlFragment;
  textNodes: Y.XmlText[];
};

export type NmlTextTarget = {
  nodeId: string;
  kind: "inline" | "code" | "math";
  text: string;
  shared: Y.XmlFragment | Y.Text;
  textNodes: Y.XmlText[];
};

export class NmlYjsDecodeError extends Error {
  constructor(readonly issues: NmlIssue[]) {
    super(issues.map((issue) => issue.message).join("; ") || "Invalid canonical NML Yjs state");
    this.name = "NmlYjsDecodeError";
  }
}

type JsonObject = Record<string, unknown>;

function mapOf(value: JsonObject): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) map.set(key, sharedValue(entry));
  }
  return map;
}

function sharedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    array.insert(0, value.map(sharedValue));
    return array;
  }
  if (value !== null && typeof value === "object") return mapOf(value as JsonObject);
  return value;
}

function plainValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    return Object.fromEntries([...value.entries()].map(([key, entry]) => [key, plainValue(entry)]));
  }
  if (value instanceof Y.Array) return value.toArray().map(plainValue);
  return value;
}

function xmlText(text: string, marks: readonly NmlMark[] = []): Y.XmlText {
  const node = new Y.XmlText();
  node.insert(0, text, Object.fromEntries(marks.map((mark) => [mark, "true"])));
  return node;
}

function inlineNodesToY(content: NmlInlineContent): Array<Y.XmlText | Y.XmlElement> {
  return content.map((inline) => {
    if (inline.type === "text") return xmlText(inline.text, inline.marks);
    const element = new Y.XmlElement(inline.type);
    if (inline.type === "link") {
      element.setAttribute("href", inline.href);
      element.insert(0, inline.content.map((text) => xmlText(text.text, text.marks)));
    } else if (inline.type === "math") {
      element.setAttribute("id", inline.id);
      element.setAttribute("latex", inline.latex);
    } else {
      element.setAttribute("id", inline.id);
      element.setAttribute("pageId", inline.pageId);
      element.setAttribute("fallbackTitle", inline.fallbackTitle);
    }
    return element;
  });
}

function inlineToY(content: NmlInlineContent): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  const nodes = inlineNodesToY(content);
  fragment.insert(0, nodes);
  return fragment;
}

function marksOf(node: Y.XmlText): NmlMark[] {
  const attributes = node.getAttributes();
  for (const key of Object.keys(attributes)) {
    if (!(NML_MARKS as readonly string[]).includes(key)) throw decodeFailure(["inline", key], `Unknown inline mark ${key}.`);
  }
  return NML_MARKS.filter((mark) => attributes[mark] === "true");
}

type SharedTextRun = {
  type: "text";
  text: string;
  marks: NmlMark[];
  href?: string;
  linkKey?: string;
};

function textRuns(
  node: Y.XmlText,
  path: Array<string | number>,
  inheritedLink?: { href: string; key: string },
): SharedTextRun[] {
  const inherited = marksOf(node);
  const deltas = node.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>;
  return deltas.flatMap((delta, index) => {
    if (typeof delta.insert !== "string") throw decodeFailure([...path, index], "Inline text may contain strings only.");
    const attributes = delta.attributes ?? {};
    for (const [key, value] of Object.entries(attributes)) {
      if ((NML_MARKS as readonly string[]).includes(key) && value === "true") continue;
      if ((key === "linkHref" || key === "linkKey") && typeof value === "string") continue;
      {
        throw decodeFailure([...path, index, key], `Unknown inline mark ${key}.`);
      }
    }
    const marks = NML_MARKS.filter((mark) => attributes[mark] === "true" || (!(mark in attributes) && inherited.includes(mark)));
    const explicitHref = attributes.linkHref;
    const href = typeof explicitHref === "string"
      ? explicitHref || undefined
      : inheritedLink?.href;
    const explicitKey = attributes.linkKey;
    const linkKey = href
      ? typeof explicitKey === "string" ? explicitKey : inheritedLink?.key
      : undefined;
    return delta.insert ? [{ type: "text" as const, text: delta.insert, marks, ...(href ? { href, linkKey } : {}) }] : [];
  });
}

function inlineFromY(value: unknown, path: Array<string | number>): NmlInlineContent {
  if (!(value instanceof Y.XmlFragment)) throw decodeFailure(path, "Expected collaborative inline content.");
  const result: NmlInlineContent = [];
  const appendTextRuns = (runs: SharedTextRun[]) => runs.forEach(({ href, linkKey, ...text }) => {
    if (!href) {
      result.push(text);
      return;
    }
    const previous = result.at(-1);
    const previousKey = previous?.type === "link" ? (previous as typeof previous & { _linkKey?: string })._linkKey : undefined;
    if (previous?.type === "link" && previous.href === href && previousKey === linkKey) previous.content.push(text);
    else result.push(Object.assign({ type: "link" as const, href, content: [text] }, { _linkKey: linkKey }));
  });
  value.toArray().forEach((node, index) => {
    if (node instanceof Y.XmlText) {
      appendTextRuns(textRuns(node, [...path, index]));
      return;
    }
    if (!(node instanceof Y.XmlElement)) throw decodeFailure([...path, index], "Unknown inline shared type.");
    if (node.nodeName === "link") {
      assertAttributes(node, ["href"], [...path, index]);
      const href = stringAttr(node, "href", path);
      node.toArray().forEach((child, childIndex) => {
        if (!(child instanceof Y.XmlText)) throw decodeFailure([...path, index, childIndex], "Links may contain text only.");
        appendTextRuns(textRuns(child, [...path, index, childIndex], { href, key: `element:${index}` }));
      });
      return;
    }
    if (node.nodeName === "math") {
      assertAttributes(node, ["id", "latex"], [...path, index]);
      if (node.length) throw decodeFailure([...path, index], "Inline math cannot have children.");
      result.push({ type: "math", id: stringAttr(node, "id", path), latex: stringAttr(node, "latex", path) });
      return;
    }
    if (node.nodeName === "pageRef") {
      assertAttributes(node, ["id", "pageId", "fallbackTitle"], [...path, index]);
      if (node.length) throw decodeFailure([...path, index], "Page references cannot have children.");
      result.push({
        type: "pageRef",
        id: stringAttr(node, "id", path),
        pageId: stringAttr(node, "pageId", path),
        fallbackTitle: stringAttr(node, "fallbackTitle", path),
      });
      return;
    }
    throw decodeFailure([...path, index], `Unknown inline node ${node.nodeName}.`);
  });
  return result.map((node) => {
    if (node.type !== "link") return node;
    const { _linkKey: _discard, ...link } = node as typeof node & { _linkKey?: string };
    return link;
  });
}

function assertAttributes(node: Y.XmlElement, allowed: readonly string[], path: Array<string | number>): void {
  for (const key of Object.keys(node.getAttributes())) {
    if (!allowed.includes(key)) throw decodeFailure([...path, key], `Unknown inline attribute ${key}.`);
  }
}

function stringAttr(node: Y.XmlElement, key: string, path: Array<string | number>): string {
  const value = node.getAttribute(key);
  if (typeof value !== "string") throw decodeFailure([...path, key], `Expected ${key} to be a string.`);
  return value;
}

function canvasToY(scene: Scene): Y.Map<unknown> {
  const root = mapOf({
    schemaVersion: NML_YJS_ENCODING_VERSION,
    w: scene.w,
    h: scene.h,
    style: scene.style,
    attrs: scene.attrs,
    ...(scene.id === undefined ? {} : { id: scene.id }),
  });
  const shapes = new Y.Map<unknown>();
  const add = (nodes: SceneNode[], parentId: string | null) => {
    nodes.forEach((node, index) => {
      const { id, kind, x, y, w, h, rot, style, label, name, locked, hidden, attrs, ...specific } = node;
      const entry = mapOf({
        kind,
        parentId,
        orderKey: keyForIndex(index),
        geometry: { x, y, w, h, rot },
        style,
        attrs,
        locked,
        hidden,
        ...(name === undefined ? {} : { name }),
        ...Object.fromEntries(Object.entries(specific).filter(([key]) => key !== "children")),
      });
      entry.set("label", textValue(label));
      shapes.set(id, entry);
      if (node.kind === "group") add(node.children, id);
    });
  };
  add(scene.nodes, null);
  const edges = new Y.Map<unknown>();
  scene.edges.forEach((edge, index) => {
    const { id, label, ...fields } = edge;
    const entry = mapOf({ ...fields, orderKey: keyForIndex(index) });
    entry.set("label", textValue(label));
    edges.set(id, entry);
  });
  root.set("shapes", shapes);
  root.set("edges", edges);
  return root;
}

function textValue(value: string): Y.Text {
  const text = new Y.Text();
  text.insert(0, value);
  return text;
}

function canvasFromY(value: unknown, path: Array<string | number>): Scene {
  const root = expectMap(value, path);
  assertKeys(root, ["schemaVersion", "w", "h", "style", "attrs", "id", "shapes", "edges"], path);
  if (root.get("schemaVersion") !== NML_YJS_ENCODING_VERSION) {
    throw decodeFailure([...path, "schemaVersion"], "Unsupported canvas Yjs encoding version.");
  }
  const shapeMap = expectMap(root.get("shapes"), [...path, "shapes"]);
  type ShapeRow = { id: string; parentId: string | null; orderKey: string; node: SceneNode };
  const rows: ShapeRow[] = [];
  shapeMap.forEach((raw, id) => {
    const entry = expectMap(raw, [...path, "shapes", id]);
    assertKeys(entry, ["kind", "parentId", "orderKey", "geometry", "style", "attrs", "locked", "hidden", "name", "label", "src", "d", "sides", "start", "sweep", "inner"], [...path, "shapes", id]);
    const kind = expectString(entry.get("kind"), [...path, "shapes", id, "kind"]);
    const geometry = plainValue(expectMap(entry.get("geometry"), [...path, "shapes", id, "geometry"])) as JsonObject;
    const common = {
      id,
      kind,
      ...geometry,
      style: plainValue(expectMap(entry.get("style"), [...path, "shapes", id, "style"])),
      label: expectText(entry.get("label"), [...path, "shapes", id, "label"]),
      locked: entry.get("locked"),
      hidden: entry.get("hidden"),
      attrs: plainValue(expectMap(entry.get("attrs"), [...path, "shapes", id, "attrs"])),
      ...(entry.has("name") ? { name: entry.get("name") } : {}),
    } as JsonObject;
    for (const key of ["src", "d", "sides", "start", "sweep", "inner"]) {
      if (entry.has(key)) common[key] = entry.get(key);
    }
    if (kind === "group") common.children = [];
    rows.push({
      id,
      parentId: (entry.get("parentId") as string | null) ?? null,
      orderKey: expectString(entry.get("orderKey"), [...path, "shapes", id, "orderKey"]),
      node: common as unknown as SceneNode,
    });
  });
  const byParent = new Map<string | null, ShapeRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const building = new Set<string>();
  const build = (parentId: string | null): SceneNode[] => (byParent.get(parentId) ?? [])
    .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id))
    .map((row) => {
      if (building.has(row.id)) throw decodeFailure([...path, "shapes", row.id], "Canvas parent cycle.");
      if (row.node.kind !== "group") return row.node;
      building.add(row.id);
      const node = { ...row.node, children: build(row.id) };
      building.delete(row.id);
      return node;
    });
  const known = new Set(rows.map((row) => row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.parentId !== null && !known.has(row.parentId)) throw decodeFailure([...path, "shapes", row.id, "parentId"], "Unknown canvas parent.");
    if (row.parentId !== null && byId.get(row.parentId)?.node.kind !== "group") throw decodeFailure([...path, "shapes", row.id, "parentId"], "Canvas parent must be a group.");
    const ancestors = new Set([row.id]);
    let parentId = row.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) throw decodeFailure([...path, "shapes", row.id, "parentId"], "Canvas parent cycle.");
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  const edgesMap = expectMap(root.get("edges"), [...path, "edges"]);
  const edges: Array<{ orderKey: string; edge: SceneEdge }> = [];
  edgesMap.forEach((raw, id) => {
    const entry = expectMap(raw, [...path, "edges", id]);
    assertKeys(entry, ["from", "to", "label", "style", "attrs", "orderKey"], [...path, "edges", id]);
    edges.push({
      orderKey: expectString(entry.get("orderKey"), [...path, "edges", id, "orderKey"]),
      edge: {
        id,
        from: expectString(entry.get("from"), [...path, "edges", id, "from"]),
        to: expectString(entry.get("to"), [...path, "edges", id, "to"]),
        label: expectText(entry.get("label"), [...path, "edges", id, "label"]),
        style: plainValue(expectMap(entry.get("style"), [...path, "edges", id, "style"])) as Record<string, string>,
        attrs: plainValue(expectMap(entry.get("attrs"), [...path, "edges", id, "attrs"])) as Record<string, string>,
      },
    });
  });
  edges.sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.edge.id.localeCompare(b.edge.id));
  return {
    w: expectNumber(root.get("w"), [...path, "w"]),
    h: expectNumber(root.get("h"), [...path, "h"]),
    style: plainValue(expectMap(root.get("style"), [...path, "style"])) as Record<string, string>,
    nodes: build(null),
    edges: edges.map(({ edge }) => edge),
    attrs: plainValue(expectMap(root.get("attrs"), [...path, "attrs"])) as Record<string, string>,
    ...(root.has("id") ? { id: expectString(root.get("id"), [...path, "id"]) } : {}),
  };
}

function blockToY(block: NmlBlock): Y.Map<unknown> {
  const map = mapOf({ id: block.id, type: block.type, props: block.props });
  const children = new Y.Array<Y.Map<unknown>>();
  children.insert(0, block.children.map(blockToY));
  map.set("children", children);
  if ("content" in block) map.set("content", inlineToY(block.content));
  if (block.type === "table") {
    map.set("columns", sharedValue(block.columns));
    const rows = new Y.Array<Y.Map<unknown>>();
    rows.insert(0, block.rows.map((row) => {
      const encoded = mapOf({ id: row.id });
      const cells = new Y.Array<Y.Map<unknown>>();
      cells.insert(0, row.cells.map((cell, cellIndex) => {
        const value = mapOf({ id: cell.id, columnId: block.columns[cellIndex].id });
        value.set("content", inlineToY(cell.content));
        return value;
      }));
      encoded.set("cells", cells);
      return encoded;
    }));
    map.set("rows", rows);
  } else if (block.type === "codeBlock") {
    map.set("code", textValue(block.code));
  } else if (block.type === "mathBlock") {
    const rows = new Y.Array<Y.Map<unknown>>();
    rows.insert(0, block.rows.map((row) => {
      const value = mapOf({ id: row.id });
      value.set("latex", textValue(row.latex));
      return value;
    }));
    map.set("rows", rows);
  } else if (block.type === "canvas") {
    map.set("scene", canvasToY(block.scene));
  } else if (block.type === "album" || block.type === "storyboard" || block.type === "location") {
    map.set("domain", sharedValue(block.domain));
    if (block.legacyMarkup !== undefined) map.set("legacyMarkup", block.legacyMarkup);
  }
  return map;
}

function blockFromY(value: unknown, path: Array<string | number>): unknown {
  const map = expectMap(value, path);
  const type = expectString(map.get("type"), [...path, "type"]);
  const domainKeys = type === "table" ? ["columns", "rows"] :
    type === "codeBlock" ? ["code"] : type === "mathBlock" ? ["rows"] :
    type === "canvas" ? ["scene"] : ["album", "storyboard", "location"].includes(type) ? ["domain", "legacyMarkup"] :
    ["paragraph", "quote", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"].includes(type) ? ["content"] : [];
  assertKeys(map, ["id", "type", "props", "children", ...domainKeys], path);
  const base: JsonObject = {
    id: expectString(map.get("id"), [...path, "id"]),
    type,
    props: plainValue(expectMap(map.get("props"), [...path, "props"])),
    children: expectArray(map.get("children"), [...path, "children"]).toArray().map((child, index) => blockFromY(child, [...path, "children", index])),
  };
  if (["paragraph", "quote", "heading", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"].includes(type)) {
    base.content = inlineFromY(map.get("content"), [...path, "content"]);
  } else if (type === "table") {
    const columns = plainValue(expectArray(map.get("columns"), [...path, "columns"])) as Array<{ id?: unknown }>;
    const columnIds = columns.map((column, columnIndex) => expectString(column?.id, [...path, "columns", columnIndex, "id"]));
    base.columns = columns;
    base.rows = expectArray(map.get("rows"), [...path, "rows"]).toArray().map((raw, rowIndex) => {
      const row = expectMap(raw, [...path, "rows", rowIndex]);
      assertKeys(row, ["id", "cells"], [...path, "rows", rowIndex]);
      const rowId = expectString(row.get("id"), [...path, "rows", rowIndex, "id"]);
      const tagged = new Map<string, Y.Map<unknown>>();
      const positional: Y.Map<unknown>[] = [];
      expectArray(row.get("cells"), [...path, "rows", rowIndex, "cells"]).toArray().forEach((rawCell, cellIndex) => {
        const cellPath = [...path, "rows", rowIndex, "cells", cellIndex];
        const cell = expectMap(rawCell, cellPath);
        assertKeys(cell, ["id", "columnId", "content"], cellPath);
        const columnId = cell.get("columnId");
        if (columnId === undefined) positional.push(cell);
        else if (typeof columnId !== "string") throw decodeFailure([...cellPath, "columnId"], "Expected string.");
        else if (columnIds.includes(columnId)) {
          if (tagged.has(columnId)) throw decodeFailure([...cellPath, "columnId"], "Duplicate cell for table column.");
          tagged.set(columnId, cell);
        }
        // A tagged cell whose column is no longer live is the recoverable residue of a
        // concurrent column deletion. Column deletion wins in the materialized table.
      });
      const cells = columnIds.map((columnId, columnIndex) => {
        const cell = tagged.get(columnId) ?? positional.shift();
        if (!cell) return { id: nmlTableIntersectionCellId(String(base.id), rowId, columnId), content: [] };
        return {
          id: expectString(cell.get("id"), [...path, "rows", rowIndex, "cells", columnIndex, "id"]),
          content: inlineFromY(cell.get("content"), [...path, "rows", rowIndex, "cells", columnIndex, "content"]),
        };
      });
      if (positional.length) throw decodeFailure([...path, "rows", rowIndex, "cells"], "Table row has cells without live columns.");
      return {
        id: rowId,
        cells,
      };
    });
  } else if (type === "codeBlock") base.code = expectText(map.get("code"), [...path, "code"]);
  else if (type === "mathBlock") {
    base.rows = expectArray(map.get("rows"), [...path, "rows"]).toArray().map((raw, index) => {
      const row = expectMap(raw, [...path, "rows", index]);
      return { id: expectString(row.get("id"), [...path, "rows", index, "id"]), latex: expectText(row.get("latex"), [...path, "rows", index, "latex"]) };
    });
  } else if (type === "canvas") base.scene = canvasFromY(map.get("scene"), [...path, "scene"]);
  else if (type === "album" || type === "storyboard" || type === "location") {
    base.domain = plainValue(expectMap(map.get("domain"), [...path, "domain"]));
    if (map.has("legacyMarkup")) base.legacyMarkup = expectString(map.get("legacyMarkup"), [...path, "legacyMarkup"]);
  }
  return base;
}

function decodeFailure(path: Array<string | number>, message: string): NmlYjsDecodeError {
  return new NmlYjsDecodeError([{ code: "invalid_yjs_encoding", severity: "error", path, message }]);
}

function expectMap(value: unknown, path: Array<string | number>): Y.Map<unknown> {
  if (!(value instanceof Y.Map)) throw decodeFailure(path, "Expected Y.Map.");
  return value;
}

function assertKeys(map: Y.Map<unknown>, allowed: readonly string[], path: Array<string | number>): void {
  for (const key of map.keys()) {
    if (!allowed.includes(key)) throw decodeFailure([...path, key], `Unknown canonical Yjs key ${key}.`);
  }
}

function expectArray(value: unknown, path: Array<string | number>): Y.Array<unknown> {
  if (!(value instanceof Y.Array)) throw decodeFailure(path, "Expected Y.Array.");
  return value;
}

function expectText(value: unknown, path: Array<string | number>): string {
  if (!(value instanceof Y.Text)) throw decodeFailure(path, "Expected collaborative Y.Text.");
  return value.toString();
}

function expectString(value: unknown, path: Array<string | number>): string {
  if (typeof value !== "string") throw decodeFailure(path, "Expected string.");
  return value;
}

function expectNumber(value: unknown, path: Array<string | number>): number {
  if (typeof value !== "number") throw decodeFailure(path, "Expected number.");
  return value;
}

export function createNmlYDoc(document: NmlDocument, origin?: NmlTransactionOrigin): Y.Doc {
  const doc = new Y.Doc();
  writeNmlDocument(doc, document, origin);
  return doc;
}

export function writeNmlDocument(doc: Y.Doc, document: NmlDocument, origin?: NmlTransactionOrigin): void {
  const normalized = normalizeDocument(nmlDocumentSchema.parse(document));
  const root = doc.getMap<unknown>(NML_YJS_ROOT);
  if (root.size > 0) throw new Error("Canonical NML root already exists; mutate it through the semantic executor.");
  doc.transact(() => {
    root.set("encodingVersion", NML_YJS_ENCODING_VERSION);
    root.set("schemaVersion", normalized.schemaVersion);
    root.set("documentId", normalized.documentId);
    const blocks = new Y.Array<Y.Map<unknown>>();
    blocks.insert(0, normalized.blocks.map(blockToY));
    root.set("blocks", blocks);
    const structure = new Y.Map<unknown>();
    const registry = new Y.Map<Y.Map<unknown>>();
    const placements = new Y.Map<Y.Map<unknown>>();
    const deletions = new Y.Map<boolean>();
    const index = (items: Y.Array<Y.Map<unknown>>, parentId: string | null) => items.toArray().forEach((item, position) => {
      const id = String(item.get("id"));
      placements.set(id, mapOf({ parentId, orderKey: keyForIndex(position) }));
      index(item.get("children") as Y.Array<Y.Map<unknown>>, id);
    });
    index(blocks, null);
    structure.set("registry", registry);
    structure.set("placements", placements);
    structure.set("deletions", deletions);
    root.set(NML_YJS_STRUCTURE_KEY, structure);
  }, origin);
}

const PLAIN_TEXT_BLOCKS = new Set(["paragraph", "heading", "quote"]);

function inlineUnits(content: NmlInlineContent): number {
  return content.reduce((total, node) => total + (node.type === "text"
    ? node.text.length
    : node.type === "link"
      ? inlineUnits(node.content)
      : node.type === "math" ? node.latex.length : node.fallbackTitle.length), 0);
}

function documentInlineUnits(document: NmlDocument): number {
  let total = 0;
  const visit = (block: NmlBlock) => {
    if ("content" in block) total += inlineUnits(block.content);
    if (block.type === "table") block.rows.forEach((row) => row.cells.forEach((cell) => { total += inlineUnits(cell.content); }));
    block.children.forEach(visit);
  };
  document.blocks.forEach(visit);
  return total;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * A local, non-persisted ID index over canonical shared types. Initial construction is
 * O(document size); ordinary text lookup is O(1). Structural changes refresh the index.
 */
export class NmlYjsIndex {
  private blocks = new Map<string, Y.Map<unknown>>();
  private textOwners = new Map<string, { kind: NmlTextTarget["kind"]; shared: Y.XmlFragment | Y.Text }>();
  private scans = 0;
  private totalInlineUnits: number | null = null;
  private plainTextLengths = new Map<string, number>();
  private stateVector: Uint8Array = new Uint8Array();
  private initialized = false;

  constructor(private readonly doc: Y.Doc, initialDocument?: NmlDocument) {
    this.refresh(initialDocument);
  }

  refresh(document?: NmlDocument): void {
    const stateVector = Y.encodeStateVector(this.doc);
    if (this.initialized && equalBytes(this.stateVector, stateVector)) {
      if (document && this.totalInlineUnits === null) this.trackDocument(document);
      return;
    }
    const next = new Map<string, Y.Map<unknown>>();
    const textOwners = new Map<string, { kind: NmlTextTarget["kind"]; shared: Y.XmlFragment | Y.Text }>();
    const root = this.doc.getMap<unknown>(NML_YJS_ROOT);
    const indexTextOwner = (candidate: Y.Map<unknown>) => {
      const id = candidate.get("id");
      if (typeof id !== "string") return;
      const content = candidate.get("content");
      if (content instanceof Y.XmlFragment) textOwners.set(id, { kind: "inline", shared: content });
      const code = candidate.get("code");
      if (code instanceof Y.Text) textOwners.set(id, { kind: "code", shared: code });
      const latex = candidate.get("latex");
      if (latex instanceof Y.Text) textOwners.set(id, { kind: "math", shared: latex });
      const rows = candidate.get("rows");
      if (rows instanceof Y.Array) rows.toArray().forEach((row) => {
        if (!(row instanceof Y.Map)) return;
        indexTextOwner(row as Y.Map<unknown>);
        const cells = row.get("cells");
        if (cells instanceof Y.Array) cells.toArray().forEach((cell) => {
          if (cell instanceof Y.Map) indexTextOwner(cell as Y.Map<unknown>);
        });
      });
    };
    const visit = (value: unknown) => {
      if (!(value instanceof Y.Array)) return;
      for (const candidate of value.toArray()) {
        if (!(candidate instanceof Y.Map)) continue;
        const id = candidate.get("id");
        if (typeof id === "string") next.set(id, candidate as Y.Map<unknown>);
        indexTextOwner(candidate as Y.Map<unknown>);
        visit(candidate.get("children"));
      }
    };
    visit(root.get("blocks"));
    const structure = root.get(NML_YJS_STRUCTURE_KEY);
    const registry = structure instanceof Y.Map ? structure.get("registry") : null;
    if (registry instanceof Y.Map) {
      registry.forEach((candidate, id) => {
        if (candidate instanceof Y.Map) {
          next.set(id, candidate as Y.Map<unknown>);
          indexTextOwner(candidate as Y.Map<unknown>);
        }
      });
    }
    this.blocks = next;
    this.textOwners = textOwners;
    this.initialized = true;
    this.stateVector = stateVector;
    if (document) this.trackDocument(document);
    else {
      this.totalInlineUnits = null;
      this.plainTextLengths.clear();
    }
    this.scans++;
  }

  private trackDocument(document: NmlDocument): void {
    this.totalInlineUnits = documentInlineUnits(document);
    this.plainTextLengths.clear();
    const visit = (block: NmlBlock) => {
      if (PLAIN_TEXT_BLOCKS.has(block.type) && "content" in block &&
          block.content.every((node) => node.type === "text" && node.marks.length === 0)) {
        this.plainTextLengths.set(block.id, inlineUnits(block.content));
      }
      block.children.forEach(visit);
    };
    document.blocks.forEach(visit);
  }

  owns(doc: Y.Doc): boolean {
    return this.doc === doc;
  }

  isCurrent(): boolean {
    return equalBytes(this.stateVector, Y.encodeStateVector(this.doc));
  }

  allowsPlainText(finalText: ReadonlyMap<string, string>): boolean {
    if (this.totalInlineUnits === null) return false;
    let next = this.totalInlineUnits;
    for (const [nodeId, value] of finalText) {
      const prior = this.plainTextLengths.get(nodeId);
      if (prior === undefined) return false;
      next += value.length - prior;
    }
    return next <= NML_LIMITS.maxInlineUtf16;
  }

  syncPlainText(nodeIds: readonly string[]): void {
    if (this.totalInlineUnits !== null) {
      for (const nodeId of nodeIds) {
        const target = this.plainText(nodeId);
        const prior = this.plainTextLengths.get(nodeId);
        if (!target || prior === undefined) {
          this.totalInlineUnits = null;
          this.plainTextLengths.clear();
          break;
        }
        this.totalInlineUnits += target.text.length - prior;
        this.plainTextLengths.set(nodeId, target.text.length);
      }
    }
    this.stateVector = Y.encodeStateVector(this.doc);
  }

  scanCount(): number {
    return this.scans;
  }

  block(nodeId: string): Y.Map<unknown> | undefined {
    const root = this.doc.getMap<unknown>(NML_YJS_ROOT);
    const structure = root.get(NML_YJS_STRUCTURE_KEY);
    const deletions = structure instanceof Y.Map ? structure.get("deletions") : null;
    if (deletions instanceof Y.Map && deletions.get(nodeId) === true) return undefined;
    if (!this.blocks.has(nodeId) && structure instanceof Y.Map) {
      const registry = structure.get("registry");
      const candidate = registry instanceof Y.Map ? registry.get(nodeId) : null;
      if (candidate instanceof Y.Map) this.blocks.set(nodeId, candidate as Y.Map<unknown>);
    }
    return this.blocks.get(nodeId);
  }

  plainText(nodeId: string): NmlPlainTextTarget | null {
    const block = this.block(nodeId);
    const type = block?.get("type");
    const fragment = block?.get("content");
    if (!block || typeof type !== "string" || !PLAIN_TEXT_BLOCKS.has(type) || !(fragment instanceof Y.XmlFragment)) return null;
    const textNodes = fragment.toArray();
    if (!textNodes.every((node): node is Y.XmlText => node instanceof Y.XmlText &&
        Object.keys(node.getAttributes()).length === 0 &&
        (node.toDelta() as Array<{ attributes?: Record<string, unknown> }>).every((delta) => !delta.attributes || Object.keys(delta.attributes).length === 0))) return null;
    return {
      nodeId,
      type: type as NmlPlainTextTarget["type"],
      text: textNodes.map((node) => node.toString()).join(""),
      fragment,
      textNodes,
    };
  }

  text(nodeId: string): NmlTextTarget | null {
    const owner = this.textOwners.get(nodeId);
    if (!owner) return null;
    if (owner.shared instanceof Y.Text && !(owner.shared instanceof Y.XmlText)) {
      return { nodeId, kind: owner.kind, text: owner.shared.toString(), shared: owner.shared, textNodes: [] };
    }
    if (!(owner.shared instanceof Y.XmlFragment)) return null;
    const textNodes: Y.XmlText[] = [];
    let text = "";
    const visibleText = (node: Y.XmlText) => (node.toDelta() as Array<{ insert?: unknown }>)
      .map((delta) => typeof delta.insert === "string" ? delta.insert : "")
      .join("");
    const visit = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlText) {
          textNodes.push(child);
          text += visibleText(child);
        } else if (child instanceof Y.XmlElement && child.nodeName === "link") visit(child);
        else if (child instanceof Y.XmlElement && (child.nodeName === "math" || child.nodeName === "pageRef")) text += "\uFFFC";
      }
    };
    visit(owner.shared);
    return { nodeId, kind: owner.kind, text, shared: owner.shared, textNodes };
  }

  createRelativeTextPosition(
    nodeId: string,
    offset: number,
    affinity: "before" | "after",
  ): Uint8Array | null {
    const target = this.text(nodeId);
    if (!target || !Number.isInteger(offset) || offset < 0 || offset > target.text.length) return null;
    if (target.shared instanceof Y.Text && !(target.shared instanceof Y.XmlFragment)) {
      return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(target.shared, offset, affinity === "before" ? -1 : 0));
    }
    const fragment = target.shared as Y.XmlFragment;
    let at = 0;
    for (const [index, child] of fragment.toArray().entries()) {
      if (child instanceof Y.XmlText) {
        if (offset >= at && offset <= at + child.length) {
          return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(child, offset - at, affinity === "before" ? -1 : 0));
        }
        at += child.length;
      } else if (child instanceof Y.XmlElement && child.nodeName === "link") {
        for (const nested of child.toArray()) {
          if (!(nested instanceof Y.XmlText)) continue;
          if (offset >= at && offset <= at + nested.length) {
            return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(nested, offset - at, affinity === "before" ? -1 : 0));
          }
          at += nested.length;
        }
      } else {
        if (offset === at || offset === at + 1) {
          const boundary = offset === at ? index : index + 1;
          return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(fragment, boundary, affinity === "before" ? -1 : 0));
        }
        at++;
      }
    }
    return offset === at
      ? Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(fragment, fragment.length, affinity === "before" ? -1 : 0))
      : null;
  }

  resolveRelativeTextPosition(nodeId: string, encoded: Uint8Array): number | null {
    if (!(encoded instanceof Uint8Array) || encoded.length === 0 || encoded.length > 256) return null;
    const target = this.text(nodeId);
    if (!target) return null;
    try {
      const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(encoded), this.doc);
      if (!absolute) return null;
      if (target.shared instanceof Y.Text && !(target.shared instanceof Y.XmlFragment)) {
        return absolute.type === target.shared && absolute.index >= 0 && absolute.index <= target.shared.length ? absolute.index : null;
      }
      if (absolute.type === target.shared) {
        const fragment = target.shared as Y.XmlFragment;
        if (absolute.index < 0 || absolute.index > fragment.length) return null;
        let units = 0;
        fragment.toArray().slice(0, absolute.index).forEach((node) => {
          if (node instanceof Y.XmlText) units += node.length;
          else if (node instanceof Y.XmlElement && node.nodeName === "link") units += node.toArray().reduce((sum, child) => sum + (child instanceof Y.XmlText ? child.length : 0), 0);
          else units += 1;
        });
        return units;
      }
      const index = target.textNodes.indexOf(absolute.type as Y.XmlText);
      if (index < 0 || absolute.index < 0 || absolute.index > target.textNodes[index].length) return null;
      let units = 0;
      const fragment = target.shared as Y.XmlFragment;
      outer: for (const node of fragment.toArray()) {
        if (node instanceof Y.XmlText) {
          if (node === absolute.type) break;
          units += node.length;
        } else if (node instanceof Y.XmlElement && node.nodeName === "link") {
          for (const child of node.toArray()) {
            if (!(child instanceof Y.XmlText)) continue;
            if (child === absolute.type) break outer;
            units += child.length;
          }
        } else units += 1;
      }
      return units + absolute.index;
    } catch {
      return null;
    }
  }

  changedPlainTextNodeIds(transaction: Y.Transaction): string[] | null {
    const root = this.doc.getMap<unknown>(NML_YJS_ROOT);
    const ids = new Set<string>();
    for (const changedType of transaction.changed.keys()) {
      let cursor: Y.AbstractType<unknown> | null = changedType as Y.AbstractType<unknown>;
      let belongsToRoot = false;
      while (cursor) {
        if (cursor === root) {
          belongsToRoot = true;
          break;
        }
        cursor = cursor.parent as Y.AbstractType<unknown> | null;
      }
      if (!belongsToRoot) continue;

      cursor = changedType as Y.AbstractType<unknown>;
      let owner: Y.Map<unknown> | null = null;
      while (cursor && cursor !== root) {
        if (cursor instanceof Y.Map && typeof cursor.get("id") === "string" && cursor.get("content") instanceof Y.XmlFragment) {
          owner = cursor as Y.Map<unknown>;
          break;
        }
        cursor = cursor.parent as Y.AbstractType<unknown> | null;
      }
      const id = owner?.get("id");
      if (typeof id !== "string" || !this.plainText(id)) return null;
      ids.add(id);
    }
    return ids.size ? [...ids] : null;
  }
}

export function decodeNmlDocument(doc: Y.Doc): NmlDocument {
  const root = doc.getMap<unknown>(NML_YJS_ROOT);
  assertKeys(root, ["encodingVersion", "schemaVersion", "documentId", "blocks", NML_YJS_STRUCTURE_KEY], [NML_YJS_ROOT]);
  if (root.get("encodingVersion") !== NML_YJS_ENCODING_VERSION) {
    throw decodeFailure([NML_YJS_ROOT, "encodingVersion"], "Unsupported NML Yjs encoding version.");
  }
  const legacyBlocks = expectArray(root.get("blocks"), [NML_YJS_ROOT, "blocks"]);
  const candidate = {
    schemaVersion: root.get("schemaVersion"),
    documentId: root.get("documentId"),
    blocks: root.has(NML_YJS_STRUCTURE_KEY)
      ? structuredBlocks(root.get(NML_YJS_STRUCTURE_KEY), legacyBlocks)
      : legacyBlocks.toArray().map((block, index) => blockFromY(block, ["blocks", index])),
  };
  const parsed = nmlDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new NmlYjsDecodeError(parsed.error.issues.map((issue) => ({
      code: "invalid_yjs_encoding",
      severity: "error",
      path: issue.path.map(String),
      message: issue.message,
    })));
  }
  return normalizeDocument(parsed.data);
}

function structuredBlocks(value: unknown, legacy: Y.Array<unknown>): unknown[] {
  const structure = expectMap(value, [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY]);
  assertKeys(structure, ["registry", "placements", "deletions"], [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY]);
  const registry = expectMap(structure.get("registry"), [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "registry"]);
  const placements = expectMap(structure.get("placements"), [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "placements"]);
  const deletions = expectMap(structure.get("deletions"), [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "deletions"]);
  type Row = { id: string; block: JsonObject; parentId: string | null; orderKey: string };
  const maps = new Map<string, Y.Map<unknown>>();
  const collect = (raw: unknown, path: Array<string | number>) => {
    const map = expectMap(raw, path);
    const id = expectString(map.get("id"), [...path, "id"]);
    maps.set(id, map);
    const children = expectArray(map.get("children"), [...path, "children"]);
    children.toArray().forEach((child, index) => collect(child, [...path, "children", index]));
  };
  legacy.toArray().forEach((block, index) => collect(block, ["blocks", index]));
  registry.forEach((block, id) => collect(block, [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "registry", id]));
  const rows: Row[] = [];
  maps.forEach((map, id) => {
    if (deletions.get(id) === true) return;
    const placement = expectMap(placements.get(id), [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "placements", id]);
    assertKeys(placement, ["parentId", "orderKey"], [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "placements", id]);
    const parent = placement.get("parentId");
    if (parent !== null && typeof parent !== "string") throw decodeFailure([NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "placements", id, "parentId"], "Expected string or null.");
    const block = blockFromY(map, [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "registry", id]) as JsonObject;
    block.children = [];
    rows.push({ id, block, parentId: parent as string | null, orderKey: expectString(placement.get("orderKey"), [NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "placements", id, "orderKey"]) });
  });
  const live = new Set(rows.map((row) => row.id));
  const byParent = new Map<string | null, Row[]>();
  for (const row of rows) {
    // A concurrent insertion into a deleted/missing parent survives in recovery at root.
    const parentId = row.parentId !== null && live.has(row.parentId) ? row.parentId : null;
    const list = byParent.get(parentId) ?? [];
    list.push(row);
    byParent.set(parentId, list);
  }
  const building = new Set<string>();
  const build = (parentId: string | null): unknown[] => (byParent.get(parentId) ?? [])
    .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id))
    .map((row) => {
      if (building.has(row.id)) throw decodeFailure([NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY, "placements", row.id], "Block parent cycle.");
      building.add(row.id);
      row.block.children = build(row.id);
      building.delete(row.id);
      return row.block;
    });
  return build(null);
}

function positions(document: NmlDocument): Map<string, { parentId: string | null; index: number; block: NmlBlock }> {
  const result = new Map<string, { parentId: string | null; index: number; block: NmlBlock }>();
  const visit = (blocks: NmlBlock[], parentId: string | null) => blocks.forEach((block, index) => {
    result.set(block.id, { parentId, index, block });
    visit(block.children, block.id);
  });
  visit(document.blocks, null);
  return result;
}

function sharedSiblingRanks(
  source: Map<string, { parentId: string | null; index: number; block: NmlBlock }>,
  other: Map<string, { parentId: string | null; index: number; block: NmlBlock }>,
): Map<string, number> {
  const siblings = new Map<string | null, Array<{ id: string; index: number }>>();
  for (const [id, value] of source) {
    if (other.get(id)?.parentId !== value.parentId) continue;
    const rows = siblings.get(value.parentId) ?? [];
    rows.push({ id, index: value.index });
    siblings.set(value.parentId, rows);
  }
  const ranks = new Map<string, number>();
  for (const rows of siblings.values()) {
    rows.sort((left, right) => left.index - right.index);
    rows.forEach((row, rank) => ranks.set(row.id, rank));
  }
  return ranks;
}

function plainInlineText(block: NmlBlock): string | null {
  if (!("content" in block) || !block.content.every((node) => node.type === "text" && node.marks.length === 0)) return null;
  return block.content.map((node) => node.type === "text" ? node.text : "").join("");
}

const textRangeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function graphemeBoundary(text: string, offset: number, direction: "before" | "after"): number {
  if (!textRangeSegmenter) {
    if (offset > 0 && offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1])) {
      return direction === "before" ? offset - 1 : offset + 1;
    }
    return offset;
  }
  let prior = 0;
  for (const segment of textRangeSegmenter.segment(text)) {
    if (segment.index === offset) return offset;
    if (segment.index > offset) return direction === "before" ? prior : segment.index;
    prior = segment.index;
  }
  return text.length;
}

function changedTextRange(before: string, after: string): NmlTextChangeRange {
  let sharedFrom = 0;
  while (sharedFrom < before.length && sharedFrom < after.length && before[sharedFrom] === after[sharedFrom]) sharedFrom++;
  let suffix = 0;
  while (suffix < before.length - sharedFrom && suffix < after.length - sharedFrom &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const from = Math.min(
    graphemeBoundary(before, sharedFrom, "before"),
    graphemeBoundary(after, sharedFrom, "before"),
  );
  const to = graphemeBoundary(before, before.length - suffix, "after");
  const insertedTo = graphemeBoundary(after, after.length - suffix, "after");
  return { from, to, insertedLength: insertedTo - from };
}

function changed(before: NmlDocument, after: NmlDocument): NmlChange[] {
  const was = positions(before);
  const now = positions(after);
  const wasRank = sharedSiblingRanks(was, now);
  const nowRank = sharedSiblingRanks(now, was);
  const changes: NmlChange[] = [];
  for (const [id, previous] of was) {
    const next = now.get(id);
    if (!next) changes.push({ kind: "remove", parentId: previous.parentId, nodeIds: [id] });
    else if (previous.parentId !== next.parentId || wasRank.get(id) !== nowRank.get(id)) {
      changes.push({ kind: "move", nodeId: id, fromParentId: previous.parentId, toParentId: next.parentId });
    } else {
      if (JSON.stringify(previous.block.props) !== JSON.stringify(next.block.props)) {
        changes.push({ kind: "props", nodeId: id, keys: [...new Set([...Object.keys(previous.block.props), ...Object.keys(next.block.props)])].sort() });
      }
      if ("content" in previous.block && "content" in next.block && JSON.stringify(previous.block.content) !== JSON.stringify(next.block.content)) {
        const beforeText = plainInlineText(previous.block);
        const afterText = plainInlineText(next.block);
        changes.push({ kind: "text", nodeId: id, ...(beforeText !== null && afterText !== null ? { range: changedTextRange(beforeText, afterText) } : {}) });
      }
      for (const domain of ["code", "rows", "scene", "domain"] as const) {
        if (domain in previous.block && domain in next.block && JSON.stringify(previous.block[domain as keyof NmlBlock]) !== JSON.stringify(next.block[domain as keyof NmlBlock])) {
          changes.push({ kind: domain === "code" || domain === "rows" ? "text" : "replaceDomain", nodeId: id, ...(domain === "scene" || domain === "domain" ? { domain } : {}) } as NmlChange);
        }
      }
    }
  }
  for (const [id, next] of now) if (!was.has(id)) changes.push({ kind: "insert", parentId: next.parentId, nodeIds: [id] });
  return changes;
}

export function observeNmlChanges(
  doc: Y.Doc,
  listener: (changeSet: NmlChangeSet) => void,
  options: {
    initialDocument?: NmlDocument;
    index?: NmlYjsIndex;
    incrementalPlainText?: boolean;
    onFullDecode?: () => void;
  } = {},
): () => void {
  let before = options.initialDocument ? structuredClone(options.initialDocument) : decodeNmlDocument(doc);
  let beforePositions = positions(before);
  let beforeStateVector = Y.encodeStateVector(doc);
  const handler = (transaction: Y.Transaction) => {
    if (!(transaction.changedParentTypes as Map<unknown, unknown>).has(doc.getMap(NML_YJS_ROOT))) return;
    const afterStateVector = Y.encodeStateVector(doc);
    const origin = isNmlOrigin(transaction.origin) ? transaction.origin : null;
    const plainTextIds = options.incrementalPlainText ? options.index?.changedPlainTextNodeIds(transaction) : null;
    if (plainTextIds?.length) {
      const changes: NmlChange[] = [];
      let valid = true;
      for (const nodeId of plainTextIds) {
        const target = options.index?.plainText(nodeId);
        const prior = beforePositions.get(nodeId)?.block;
        if (!target || !prior || !("content" in prior) || !PLAIN_TEXT_BLOCKS.has(prior.type) ||
            !prior.content.every((node) => node.type === "text" && node.marks.length === 0)) {
          valid = false;
          break;
        }
        const beforeText = prior.content.map((node) => node.type === "text" ? node.text : "").join("");
        prior.content = target.text ? [{ type: "text", text: target.text, marks: [] }] : [];
        changes.push({ kind: "text", nodeId, range: changedTextRange(beforeText, target.text) });
      }
      if (valid) {
        options.index?.syncPlainText(plainTextIds);
        listener({ transactionId: origin?.transactionId, origin, beforeStateVector, afterStateVector, changes, diagnostics: [] });
        beforeStateVector = afterStateVector;
        return;
      }
    }
    try {
      options.onFullDecode?.();
      const after = decodeNmlDocument(doc);
      // Consumers restore selections while handling this notification, so new
      // block/cell/row text owners must be addressable before the callback.
      options.index?.refresh(after);
      listener({ transactionId: origin?.transactionId, origin, beforeStateVector, afterStateVector, changes: changed(before, after), diagnostics: [], document: after });
      before = after;
      beforePositions = positions(before);
    } catch (error) {
      listener({
        origin: isNmlOrigin(transaction.origin) ? transaction.origin : null,
        beforeStateVector,
        afterStateVector,
        changes: [],
        diagnostics: error instanceof NmlYjsDecodeError ? error.issues : [{ code: "invalid_yjs_encoding", severity: "error", path: [], message: String(error) }],
      });
    }
    beforeStateVector = afterStateVector;
  };
  doc.on("afterTransaction", handler);
  return () => doc.off("afterTransaction", handler);
}

export function isNmlOrigin(value: unknown): value is NmlTransactionOrigin {
  if (!value || typeof value !== "object") return false;
  const origin = value as Partial<NmlTransactionOrigin>;
  return origin.version === 1 && typeof origin.transactionId === "string" && typeof origin.command === "string" &&
    !!origin.actor && typeof origin.actor.userId === "string" && ["human", "model", "system"].includes(origin.actor.kind ?? "");
}

/** Internal shared-type constructors used exclusively by the semantic executor. */
export {
  blockToY as nmlBlockToY,
  canvasToY as nmlCanvasToY,
  inlineToY as nmlInlineToY,
  inlineNodesToY as nmlInlineNodesToY,
  mapOf as nmlYMapOf,
  plainValue as nmlYPlainValue,
  sharedValue as nmlYSharedValue,
};
