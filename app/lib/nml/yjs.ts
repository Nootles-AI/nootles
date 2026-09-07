import * as Y from "yjs";
import { keyForIndex } from "@/app/components/editor/canvas/collab/order";
import type { Scene, SceneEdge, SceneNode } from "@/app/components/editor/canvas/scene/types";
import { normalizeDocument } from "./normalize";
import {
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
  | { kind: "text"; nodeId: string }
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
  node.insert(0, text);
  for (const mark of marks) node.setAttribute(mark, "true");
  return node;
}

function inlineToY(content: NmlInlineContent): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  const nodes: Array<Y.XmlText | Y.XmlElement> = content.map((inline) => {
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

function inlineFromY(value: unknown, path: Array<string | number>): NmlInlineContent {
  if (!(value instanceof Y.XmlFragment)) throw decodeFailure(path, "Expected collaborative inline content.");
  return value.toArray().map((node, index) => {
    if (node instanceof Y.XmlText) return { type: "text" as const, text: node.toString(), marks: marksOf(node) };
    if (!(node instanceof Y.XmlElement)) throw decodeFailure([...path, index], "Unknown inline shared type.");
    if (node.nodeName === "link") {
      assertAttributes(node, ["href"], [...path, index]);
      const content = node.toArray().map((child, childIndex) => {
        if (!(child instanceof Y.XmlText)) throw decodeFailure([...path, index, childIndex], "Links may contain text only.");
        return { type: "text" as const, text: child.toString(), marks: marksOf(child) };
      });
      return { type: "link" as const, href: stringAttr(node, "href", path), content };
    }
    if (node.nodeName === "math") {
      assertAttributes(node, ["id", "latex"], [...path, index]);
      if (node.length) throw decodeFailure([...path, index], "Inline math cannot have children.");
      return { type: "math" as const, id: stringAttr(node, "id", path), latex: stringAttr(node, "latex", path) };
    }
    if (node.nodeName === "pageRef") {
      assertAttributes(node, ["id", "pageId", "fallbackTitle"], [...path, index]);
      if (node.length) throw decodeFailure([...path, index], "Page references cannot have children.");
      return {
        type: "pageRef" as const,
        id: stringAttr(node, "id", path),
        pageId: stringAttr(node, "pageId", path),
        fallbackTitle: stringAttr(node, "fallbackTitle", path),
      };
    }
    throw decodeFailure([...path, index], `Unknown inline node ${node.nodeName}.`);
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
      cells.insert(0, row.cells.map((cell) => {
        const value = mapOf({ id: cell.id });
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
    base.columns = plainValue(expectArray(map.get("columns"), [...path, "columns"]));
    base.rows = expectArray(map.get("rows"), [...path, "rows"]).toArray().map((raw, rowIndex) => {
      const row = expectMap(raw, [...path, "rows", rowIndex]);
      return {
        id: expectString(row.get("id"), [...path, "rows", rowIndex, "id"]),
        cells: expectArray(row.get("cells"), [...path, "rows", rowIndex, "cells"]).toArray().map((rawCell, cellIndex) => {
          const cell = expectMap(rawCell, [...path, "rows", rowIndex, "cells", cellIndex]);
          return {
            id: expectString(cell.get("id"), [...path, "rows", rowIndex, "cells", cellIndex, "id"]),
            content: inlineFromY(cell.get("content"), [...path, "rows", rowIndex, "cells", cellIndex, "content"]),
          };
        }),
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

function changed(before: NmlDocument, after: NmlDocument): NmlChange[] {
  const was = positions(before);
  const now = positions(after);
  const changes: NmlChange[] = [];
  for (const [id, previous] of was) {
    const next = now.get(id);
    if (!next) changes.push({ kind: "remove", parentId: previous.parentId, nodeIds: [id] });
    else if (previous.parentId !== next.parentId || previous.index !== next.index) {
      changes.push({ kind: "move", nodeId: id, fromParentId: previous.parentId, toParentId: next.parentId });
    } else {
      if (JSON.stringify(previous.block.props) !== JSON.stringify(next.block.props)) {
        changes.push({ kind: "props", nodeId: id, keys: [...new Set([...Object.keys(previous.block.props), ...Object.keys(next.block.props)])].sort() });
      }
      if ("content" in previous.block && "content" in next.block && JSON.stringify(previous.block.content) !== JSON.stringify(next.block.content)) {
        changes.push({ kind: "text", nodeId: id });
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

export function observeNmlChanges(doc: Y.Doc, listener: (changeSet: NmlChangeSet) => void): () => void {
  let before = decodeNmlDocument(doc);
  let beforeStateVector = Y.encodeStateVector(doc);
  const handler = (transaction: Y.Transaction) => {
    if (!(transaction.changedParentTypes as Map<unknown, unknown>).has(doc.getMap(NML_YJS_ROOT))) return;
    const afterStateVector = Y.encodeStateVector(doc);
    try {
      const after = decodeNmlDocument(doc);
      const origin = isNmlOrigin(transaction.origin) ? transaction.origin : null;
      listener({ transactionId: origin?.transactionId, origin, beforeStateVector, afterStateVector, changes: changed(before, after), diagnostics: [] });
      before = after;
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
  mapOf as nmlYMapOf,
  plainValue as nmlYPlainValue,
  sharedValue as nmlYSharedValue,
};
