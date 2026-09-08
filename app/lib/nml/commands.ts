import * as Y from "yjs";
import {
  keyBetween,
  keyForIndex,
} from "@/app/components/editor/canvas/collab/order";
import type {
  SceneEdge,
  SceneNode,
} from "@/app/components/editor/canvas/scene/types";
import { assertValidDocument, NmlValidationError } from "./validate";
import type {
  NmlBlock,
  NmlInlineContent,
  NmlMark,
  NmlTableCell,
} from "./schema";
import {
  decodeNmlDocument,
  NML_YJS_ROOT,
  NML_YJS_STRUCTURE_KEY,
  nmlBlockToY,
  nmlInlineToY,
  nmlYMapOf,
  nmlYSharedValue,
  NmlYjsIndex,
  type NmlTransactionOrigin,
} from "./yjs";

const RECEIPTS_ROOT = "nmlCommandReceipts";

export type NmlAnchor = { beforeId?: string; afterId?: string };
export type NmlRange = { from: number; to: number };
export type NmlCommand =
  | {
      type: "insertNodes";
      parentId: string | null;
      anchor?: NmlAnchor;
      nodes: NmlBlock[];
    }
  | { type: "removeNodes"; nodeIds: string[] }
  | {
      type: "moveNodes";
      nodeIds: string[];
      destination: { parentId: string | null; anchor?: NmlAnchor };
    }
  | {
      type: "setNodeProps";
      nodeId: string;
      patch: Record<string, unknown | undefined>;
    }
  | {
      type: "replaceInline";
      nodeId: string;
      range: NmlRange;
      content: NmlInlineContent;
    }
  | {
      type: "setInlineMarks";
      nodeId: string;
      range: NmlRange;
      marks: NmlMark[];
    }
  | {
      type: "splitTextBlock";
      nodeId: string;
      offset: number;
      newNodeId: string;
    }
  | { type: "joinTextBlocks"; leftId: string; rightId: string }
  | {
      type: "replaceTableRange";
      tableId: string;
      rowIds: string[];
      columnIds: string[];
      cells: NmlTableCell[][];
    }
  | { type: "setCode"; nodeId: string; range: NmlRange; text: string }
  | { type: "setMathRow"; nodeId: string; rowId: string; latex: string }
  | { type: "replaceDomain"; nodeId: string; domain: unknown }
  | {
      type: "insertShapes";
      canvasId: string;
      shapes: SceneNode[];
      parentId?: string | null;
      anchor?: NmlAnchor;
    }
  | {
      type: "updateShapes";
      canvasId: string;
      patches: Array<{
        id: string;
        patch: Record<string, unknown | undefined>;
      }>;
    }
  | {
      type: "moveShapes";
      canvasId: string;
      placements: Array<{
        id: string;
        parentId: string | null;
        anchor?: NmlAnchor;
      }>;
    }
  | { type: "removeShapes"; canvasId: string; shapeIds: string[] }
  | { type: "insertEdges"; canvasId: string; edges: SceneEdge[] }
  | {
      type: "updateEdges";
      canvasId: string;
      patches: Array<{ id: string; patch: Partial<Omit<SceneEdge, "id">> }>;
    }
  | { type: "removeEdges"; canvasId: string; edgeIds: string[] };

export type NmlCommandConflictCode =
  | "unauthorized"
  | "document_mismatch"
  | "stale_state"
  | "missing_node"
  | "duplicate_id"
  | "invalid_parent"
  | "invalid_anchor"
  | "invalid_range"
  | "incompatible_node"
  | "dangling_edge"
  | "idempotency_mismatch"
  | "invalid_command";

export class NmlCommandConflict extends Error {
  constructor(
    readonly code: NmlCommandConflictCode,
    message: string,
    readonly commandIndex?: number,
  ) {
    super(message);
    this.name = "NmlCommandConflict";
  }
}

export type NmlCommandReceipt = {
  status: "applied";
  idempotencyKey: string;
  transactionId: string;
  temporaryIds: Record<string, string>;
  commandCount: number;
};

export type ExecuteNmlCommandsOptions = {
  doc: Y.Doc;
  documentId: string;
  commands: NmlCommand[];
  origin: NmlTransactionOrigin;
  idempotencyKey: string;
  authorize: (request: {
    documentId: string;
    actor: NmlTransactionOrigin["actor"];
    access: "write";
  }) => boolean | Promise<boolean>;
  temporaryIds?: string[];
  createId?: (temporaryId: string) => string;
  preconditions?: {
    stateVector?: Uint8Array;
    nodes?: Record<string, "exists" | "absent">;
  };
  /** A caller-owned index enables the validated O(1) plain-text execution path. */
  index?: NmlYjsIndex;
};

type BlockRef = {
  map: Y.Map<unknown>;
  array?: Y.Array<Y.Map<unknown>>;
  index: number;
  parentId: string | null;
};
type Structure = {
  registry: Y.Map<Y.Map<unknown>>;
  placements: Y.Map<Y.Map<unknown>>;
  deletions: Y.Map<boolean>;
};

function conflict(code: NmlCommandConflictCode, message: string): never {
  throw new NmlCommandConflict(code, message);
}
function rootBlocks(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  const blocks = doc.getMap(NML_YJS_ROOT).get("blocks");
  if (!(blocks instanceof Y.Array))
    return conflict("invalid_command", "Canonical block root is missing.");
  return blocks as Y.Array<Y.Map<unknown>>;
}
function blockIndex(doc: Y.Doc): Map<string, BlockRef> {
  const result = new Map<string, BlockRef>();
  const visit = (array: Y.Array<Y.Map<unknown>>, parentId: string | null) =>
    array.toArray().forEach((map, index) => {
      const id = map.get("id");
      if (typeof id !== "string")
        conflict("invalid_command", "Canonical block has no ID.");
      result.set(id, { map, array, index, parentId });
      const children = map.get("children");
      if (children instanceof Y.Array)
        visit(children as Y.Array<Y.Map<unknown>>, id);
    });
  visit(rootBlocks(doc), null);
  const rawStructure = doc.getMap(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY);
  if (rawStructure instanceof Y.Map) {
    const deletions = rawStructure.get("deletions") as Y.Map<boolean>;
    const registry = rawStructure.get("registry") as Y.Map<Y.Map<unknown>>;
    registry.forEach((map, id) => {
      if (deletions.get(id) !== true)
        result.set(id, { map, index: -1, parentId: null });
    });
    deletions.forEach((deleted, id) => {
      if (deleted) result.delete(id);
    });
  }
  return result;
}
function needBlock(doc: Y.Doc, id: string): BlockRef {
  return (
    blockIndex(doc).get(id) ??
    conflict("missing_node", `Node ${id} does not exist.`)
  );
}
function ensureStructure(doc: Y.Doc): Structure {
  const root = doc.getMap<unknown>(NML_YJS_ROOT);
  const existing = root.get(NML_YJS_STRUCTURE_KEY);
  if (existing instanceof Y.Map)
    return {
      registry: existing.get("registry") as Y.Map<Y.Map<unknown>>,
      placements: existing.get("placements") as Y.Map<Y.Map<unknown>>,
      deletions: existing.get("deletions") as Y.Map<boolean>,
    };
  const structure = new Y.Map<unknown>();
  const registry = new Y.Map<Y.Map<unknown>>();
  const placements = new Y.Map<Y.Map<unknown>>();
  const deletions = new Y.Map<boolean>();
  const visit = (array: Y.Array<Y.Map<unknown>>, parentId: string | null) =>
    array.toArray().forEach((map, index) => {
      const id = String(map.get("id"));
      placements.set(id, nmlYMapOf({ parentId, orderKey: keyForIndex(index) }));
      const children = map.get("children");
      if (children instanceof Y.Array)
        visit(children as Y.Array<Y.Map<unknown>>, id);
    });
  visit(rootBlocks(doc), null);
  structure.set("registry", registry);
  structure.set("placements", placements);
  structure.set("deletions", deletions);
  root.set(NML_YJS_STRUCTURE_KEY, structure);
  return { registry, placements, deletions };
}
function assertAnchor(anchor?: NmlAnchor): void {
  if (anchor?.beforeId && anchor.afterId)
    conflict(
      "invalid_anchor",
      "An anchor cannot specify both beforeId and afterId.",
    );
}
function decodedPositions(
  doc: Y.Doc,
): Map<string, { parentId: string | null; index: number; block: NmlBlock }> {
  const result = new Map<
    string,
    { parentId: string | null; index: number; block: NmlBlock }
  >();
  const visit = (blocks: NmlBlock[], parentId: string | null) =>
    blocks.forEach((block, index) => {
      result.set(block.id, { parentId, index, block });
      visit(block.children, block.id);
    });
  visit(decodeNmlDocument(doc).blocks, null);
  return result;
}
function blockOrder(
  structure: Structure,
  doc: Y.Doc,
  parentId: string | null,
  anchor?: NmlAnchor,
): string {
  assertAnchor(anchor);
  const siblings = [...decodedPositions(doc).entries()]
    .filter(([, value]) => value.parentId === parentId)
    .map(([id]) => ({
      id,
      order: String(structure.placements.get(id)?.get("orderKey")),
    }))
    .sort((a, b) => a.order.localeCompare(b.order) || a.id.localeCompare(b.id));
  let index = siblings.length;
  if (anchor) {
    const id = anchor.beforeId ?? anchor.afterId;
    const found = siblings.findIndex((row) => row.id === id);
    if (found >= 0) index = anchor.afterId ? found + 1 : found;
  }
  return keyBetween(
    siblings[index - 1]?.order ?? null,
    siblings[index]?.order ?? null,
  );
}
function registerBlocks(
  structure: Structure,
  nodes: NmlBlock[],
  parentId: string | null,
  firstOrder: string,
): void {
  nodes.forEach((node, index) => {
    structure.registry.set(
      node.id,
      nmlBlockToY({ ...node, children: [] } as NmlBlock),
    );
    structure.placements.set(
      node.id,
      nmlYMapOf({
        parentId,
        orderKey:
          index === 0
            ? firstOrder
            : keyBetween(
                String(
                  structure.placements
                    .get(nodes[index - 1].id)
                    ?.get("orderKey"),
                ),
                null,
              ),
      }),
    );
    if (node.children.length)
      registerBlocks(structure, node.children, node.id, keyForIndex(0));
  });
}
function assertRange(range: NmlRange, length: number): void {
  if (
    !Number.isInteger(range.from) ||
    !Number.isInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from ||
    range.to > length
  ) {
    conflict(
      "invalid_range",
      `Range ${range.from}..${range.to} is outside 0..${length}.`,
    );
  }
}
function isGraphemeBoundary(text: string, offset: number): boolean {
  const Segmenter = Intl.Segmenter;
  if (!Segmenter)
    return !(
      offset > 0 &&
      offset < text.length &&
      /[\uDC00-\uDFFF]/.test(text[offset])
    );
  return (
    [
      ...new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ].some((part) => part.index === offset) || offset === text.length
  );
}
function inlineLength(content: NmlInlineContent): number {
  return content.reduce(
    (sum, node) =>
      sum +
      (node.type === "text"
        ? node.text.length
        : node.type === "link"
          ? inlineLength(node.content)
          : 1),
    0,
  );
}
function inlineText(content: NmlInlineContent): string {
  return content
    .map((node) =>
      node.type === "text"
        ? node.text
        : node.type === "link"
          ? inlineText(node.content)
          : "\uFFFC",
    )
    .join("");
}
function sliceInline(
  content: NmlInlineContent,
  from: number,
  to: number,
): NmlInlineContent {
  let at = 0;
  const out: NmlInlineContent = [];
  for (const node of content) {
    const length =
      node.type === "text"
        ? node.text.length
        : node.type === "link"
          ? inlineLength(node.content)
          : 1;
    const lo = Math.max(0, from - at),
      hi = Math.min(length, to - at);
    if (hi > lo) {
      if (node.type === "text")
        out.push({ ...node, text: node.text.slice(lo, hi) });
      else if (node.type === "link")
        out.push({
          ...node,
          content: sliceInline(node.content, lo, hi).filter(
            (n): n is Extract<typeof n, { type: "text" }> => n.type === "text",
          ),
        });
      else if (lo === 0 && hi === 1) out.push(node);
    }
    at += length;
  }
  return out;
}
function inlineBlock(
  doc: Y.Doc,
  id: string,
): { ref: BlockRef; content: NmlInlineContent } {
  const ref = needBlock(doc, id);
  const decoded = decodeNmlDocument(doc);
  const stack = [...decoded.blocks];
  let found: NmlBlock | undefined;
  while (stack.length) {
    const item = stack.shift()!;
    if (item.id === id) {
      found = item;
      break;
    }
    stack.unshift(...item.children);
  }
  if (!found || !("content" in found))
    return conflict("incompatible_node", `Node ${id} has no inline content.`);
  return { ref, content: found.content };
}
function replaceInline(
  doc: Y.Doc,
  id: string,
  range: NmlRange,
  inserted: NmlInlineContent,
  marks?: NmlMark[],
): void {
  const { ref, content } = inlineBlock(doc, id);
  const length = inlineLength(content);
  assertRange(range, length);
  const text = inlineText(content);
  if (
    !isGraphemeBoundary(text, range.from) ||
    !isGraphemeBoundary(text, range.to)
  )
    conflict("invalid_range", "Inline ranges cannot split a grapheme cluster.");
  const shared = ref.map.get("content");
  const onlyText =
    content.length === 1 && content[0].type === "text" ? content[0] : null;
  if (
    !marks &&
    onlyText &&
    inserted.every(
      (node) =>
        node.type === "text" &&
        JSON.stringify(node.marks) === JSON.stringify(onlyText.marks),
    ) &&
    shared instanceof Y.XmlFragment
  ) {
    const child = shared.get(0);
    if (child instanceof Y.XmlText) {
      child.delete(range.from, range.to - range.from);
      const replacement = inserted
        .map((node) => (node.type === "text" ? node.text : ""))
        .join("");
      if (replacement) child.insert(range.from, replacement);
      return;
    }
  }
  let middle = inserted;
  if (marks)
    middle = sliceInline(content, range.from, range.to).map((node) =>
      node.type === "text"
        ? { ...node, marks }
        : node.type === "link"
          ? {
              ...node,
              content: node.content.map((part) => ({ ...part, marks })),
            }
          : node,
    );
  ref.map.set(
    "content",
    nmlInlineToY([
      ...sliceInline(content, 0, range.from),
      ...middle,
      ...sliceInline(content, range.to, length),
    ]),
  );
}
function canvas(
  doc: Y.Doc,
  id: string,
): {
  scene: Y.Map<unknown>;
  shapes: Y.Map<Y.Map<unknown>>;
  edges: Y.Map<Y.Map<unknown>>;
} {
  const block = needBlock(doc, id).map;
  if (block.get("type") !== "canvas" || !(block.get("scene") instanceof Y.Map))
    return conflict("incompatible_node", `Node ${id} is not a canvas.`);
  const scene = block.get("scene") as Y.Map<unknown>;
  return {
    scene,
    shapes: scene.get("shapes") as Y.Map<Y.Map<unknown>>,
    edges: scene.get("edges") as Y.Map<Y.Map<unknown>>,
  };
}
function ordered(
  map: Y.Map<Y.Map<unknown>>,
  parentId: string | null,
): Array<{ id: string; order: string }> {
  return [...map.entries()]
    .filter(([, value]) => (value.get("parentId") ?? null) === parentId)
    .map(([id, value]) => ({ id, order: String(value.get("orderKey")) }))
    .sort((a, b) => a.order.localeCompare(b.order) || a.id.localeCompare(b.id));
}
function orderAt(
  map: Y.Map<Y.Map<unknown>>,
  parentId: string | null,
  anchor?: NmlAnchor,
): string {
  const list = ordered(map, parentId);
  let index = list.length;
  if (anchor) {
    const id = anchor.beforeId ?? anchor.afterId;
    const found = list.findIndex((row) => row.id === id);
    if (found >= 0) index = anchor.afterId ? found + 1 : found;
  }
  return keyBetween(list[index - 1]?.order ?? null, list[index]?.order ?? null);
}
function encodeShape(
  node: SceneNode,
  parentId: string | null,
  orderKey: string,
): Y.Map<unknown> {
  const {
    id: _id,
    kind,
    x,
    y,
    w,
    h,
    rot,
    style,
    label,
    name,
    locked,
    hidden,
    attrs,
    ...specific
  } = node;
  const value = nmlYMapOf({
    kind,
    parentId,
    orderKey,
    geometry: { x, y, w, h, rot },
    style,
    attrs,
    locked,
    hidden,
    ...(name === undefined ? {} : { name }),
    ...Object.fromEntries(
      Object.entries(specific).filter(([key]) => key !== "children"),
    ),
  });
  const text = new Y.Text();
  text.insert(0, label);
  value.set("label", text);
  return value;
}
function encodeEdge(edge: SceneEdge, orderKey: string): Y.Map<unknown> {
  const { id: _id, label, ...rest } = edge;
  const value = nmlYMapOf({ ...rest, orderKey });
  const text = new Y.Text();
  text.insert(0, label);
  value.set("label", text);
  return value;
}
function apply(doc: Y.Doc, command: NmlCommand): void {
  switch (command.type) {
    case "insertNodes": {
      const known = blockIndex(doc);
      const ids: string[] = [];
      const collect = (nodes: NmlBlock[]) =>
        nodes.forEach((n) => {
          ids.push(n.id);
          collect(n.children);
        });
      collect(command.nodes);
      if (new Set(ids).size !== ids.length || ids.some((id) => known.has(id)))
        conflict("duplicate_id", "Inserted node ID already exists.");
      if (command.parentId !== null) needBlock(doc, command.parentId);
      const structure = ensureStructure(doc);
      registerBlocks(
        structure,
        command.nodes,
        command.parentId,
        blockOrder(structure, doc, command.parentId, command.anchor),
      );
      return;
    }
    case "removeNodes": {
      const positions = decodedPositions(doc);
      command.nodeIds.forEach((id) => {
        if (!positions.has(id))
          conflict("missing_node", `Node ${id} does not exist.`);
      });
      const structure = ensureStructure(doc);
      const remove = new Set<string>();
      const collect = (id: string) => {
        remove.add(id);
        positions.forEach((value, child) => {
          if (value.parentId === id) collect(child);
        });
      };
      command.nodeIds.forEach(collect);
      remove.forEach((id) => structure.deletions.set(id, true));
      return;
    }
    case "moveNodes": {
      const positions = decodedPositions(doc);
      command.nodeIds.forEach((id) => {
        if (!positions.has(id))
          conflict("missing_node", `Node ${id} does not exist.`);
      });
      if (
        command.destination.parentId !== null &&
        !positions.has(command.destination.parentId)
      )
        conflict("invalid_parent", "Move destination does not exist.");
      for (const id of command.nodeIds) {
        let parent = command.destination.parentId;
        while (parent !== null) {
          if (parent === id)
            conflict(
              "invalid_parent",
              "A node cannot move into its own subtree.",
            );
          parent = positions.get(parent)?.parentId ?? null;
        }
      }
      const structure = ensureStructure(doc);
      command.nodeIds.forEach((id) =>
        structure.placements.set(
          id,
          nmlYMapOf({
            parentId: command.destination.parentId,
            orderKey: blockOrder(
              structure,
              doc,
              command.destination.parentId,
              command.destination.anchor,
            ),
          }),
        ),
      );
      return;
    }
    case "setNodeProps": {
      const props = needBlock(doc, command.nodeId).map.get("props");
      if (!(props instanceof Y.Map))
        conflict("incompatible_node", "Node has no property map.");
      for (const [key, value] of Object.entries(command.patch)) {
        if (value === undefined) props.delete(key);
        else props.set(key, nmlYSharedValue(value));
      }
      return;
    }
    case "replaceInline":
      replaceInline(doc, command.nodeId, command.range, command.content);
      return;
    case "setInlineMarks":
      replaceInline(doc, command.nodeId, command.range, [], command.marks);
      return;
    case "splitTextBlock": {
      const { ref, content } = inlineBlock(doc, command.nodeId);
      if (blockIndex(doc).has(command.newNodeId))
        conflict("duplicate_id", `Node ${command.newNodeId} already exists.`);
      assertRange(
        { from: command.offset, to: command.offset },
        inlineLength(content),
      );
      const original = findDecoded(doc, command.nodeId);
      if (!isGraphemeBoundary(inlineText(content), command.offset))
        conflict("invalid_range", "Split cannot divide a grapheme cluster.");
      ref.map.set(
        "content",
        nmlInlineToY(sliceInline(content, 0, command.offset)),
      );
      const next = {
        ...original,
        id: command.newNodeId,
        content: sliceInline(content, command.offset, inlineLength(content)),
        children: [],
      } as NmlBlock;
      const positions = decodedPositions(doc);
      const position = positions.get(command.nodeId)!;
      const structure = ensureStructure(doc);
      registerBlocks(
        structure,
        [next],
        position.parentId,
        blockOrder(structure, doc, position.parentId, {
          afterId: command.nodeId,
        }),
      );
      return;
    }
    case "joinTextBlocks": {
      const left = inlineBlock(doc, command.leftId),
        right = inlineBlock(doc, command.rightId);
      const positions = decodedPositions(doc),
        lp = positions.get(command.leftId)!,
        rp = positions.get(command.rightId)!;
      if (lp.parentId !== rp.parentId || rp.index !== lp.index + 1)
        conflict(
          "incompatible_node",
          "Joined text blocks must be adjacent siblings.",
        );
      left.ref.map.set(
        "content",
        nmlInlineToY([...left.content, ...right.content]),
      );
      ensureStructure(doc).deletions.set(command.rightId, true);
      return;
    }
    case "replaceTableRange": {
      const ref = needBlock(doc, command.tableId).map;
      if (ref.get("type") !== "table")
        conflict("incompatible_node", "Target is not a table.");
      const columns = (ref.get("columns") as Y.Array<Y.Map<unknown>>).toArray();
      const rows = (ref.get("rows") as Y.Array<Y.Map<unknown>>).toArray();
      const cis = command.columnIds.map((id) =>
        columns.findIndex((c) => c.get("id") === id),
      );
      const ris = command.rowIds.map((id) =>
        rows.findIndex((r) => r.get("id") === id),
      );
      if (
        cis.some((i) => i < 0) ||
        ris.some((i) => i < 0) ||
        command.cells.length !== ris.length ||
        command.cells.some((row) => row.length !== cis.length)
      )
        conflict(
          "invalid_range",
          "Table range is not a complete addressed rectangle.",
        );
      ris.forEach((ri, r) => {
        const cells = rows[ri].get("cells") as Y.Array<Y.Map<unknown>>;
        cis.forEach((ci, c) => {
          const cell = command.cells[r][c];
          const current = cells.get(ci);
          if (cell.id !== current.get("id"))
            conflict(
              "invalid_command",
              "Replacement cells must preserve stable cell IDs.",
            );
          current.set("content", nmlInlineToY(cell.content));
        });
      });
      return;
    }
    case "setCode": {
      const ref = needBlock(doc, command.nodeId).map;
      const text = ref.get("code");
      if (!(text instanceof Y.Text))
        conflict("incompatible_node", "Target is not a code block.");
      assertRange(command.range, text.length);
      text.delete(command.range.from, command.range.to - command.range.from);
      if (command.text) text.insert(command.range.from, command.text);
      return;
    }
    case "setMathRow": {
      const ref = needBlock(doc, command.nodeId).map;
      if (ref.get("type") !== "mathBlock")
        conflict("incompatible_node", "Target is not a math block.");
      const row = (ref.get("rows") as Y.Array<Y.Map<unknown>>)
        .toArray()
        .find((value) => value.get("id") === command.rowId);
      if (!row)
        conflict("missing_node", `Math row ${command.rowId} does not exist.`);
      const text = row.get("latex") as Y.Text;
      text.delete(0, text.length);
      text.insert(0, command.latex);
      return;
    }
    case "replaceDomain": {
      const ref = needBlock(doc, command.nodeId).map;
      if (
        !["album", "storyboard", "location"].includes(String(ref.get("type")))
      )
        conflict("incompatible_node", "Target has no atomic custom domain.");
      ref.set("domain", nmlYSharedValue(command.domain));
      return;
    }
    case "insertShapes": {
      const { shapes } = canvas(doc, command.canvasId);
      const add = (nodes: SceneNode[], parent: string | null) =>
        nodes.forEach((node) => {
          if (shapes.has(node.id))
            conflict("duplicate_id", `Shape ${node.id} exists.`);
          const order = orderAt(shapes, parent, command.anchor);
          shapes.set(node.id, encodeShape(node, parent, order));
          if (node.kind === "group") add(node.children, node.id);
        });
      add(command.shapes, command.parentId ?? null);
      return;
    }
    case "updateShapes": {
      const { shapes } = canvas(doc, command.canvasId);
      command.patches.forEach(({ id, patch }) => {
        const value = shapes.get(id);
        if (!value) conflict("missing_node", `Shape ${id} does not exist.`);
        for (const [key, next] of Object.entries(patch)) {
          if (["id", "kind", "children", "parentId", "orderKey"].includes(key))
            conflict("invalid_command", `Shape field ${key} is not patchable.`);
          if (key === "label") {
            const text = value.get("label") as Y.Text;
            text.delete(0, text.length);
            text.insert(0, String(next ?? ""));
          } else if (["x", "y", "w", "h", "rot"].includes(key)) {
            const old = value.get("geometry") as Y.Map<unknown>;
            const data = Object.fromEntries(old.entries());
            data[key] = next;
            value.set("geometry", nmlYMapOf(data));
          } else if (next === undefined) value.delete(key);
          else value.set(key, nmlYSharedValue(next));
        }
      });
      return;
    }
    case "moveShapes": {
      const { shapes } = canvas(doc, command.canvasId);
      command.placements.forEach((place) => {
        const value = shapes.get(place.id);
        if (!value)
          conflict("missing_node", `Shape ${place.id} does not exist.`);
        if (
          place.parentId !== null &&
          (!shapes.has(place.parentId) ||
            shapes.get(place.parentId)?.get("kind") !== "group")
        )
          conflict("invalid_parent", "Shape parent must be a group.");
        value.set("parentId", place.parentId);
        value.set("orderKey", orderAt(shapes, place.parentId, place.anchor));
      });
      return;
    }
    case "removeShapes": {
      const { shapes, edges } = canvas(doc, command.canvasId);
      const remove = new Set(command.shapeIds);
      let grew = true;
      while (grew) {
        grew = false;
        shapes.forEach((value, id) => {
          if (remove.has(String(value.get("parentId"))) && !remove.has(id)) {
            remove.add(id);
            grew = true;
          }
        });
      }
      remove.forEach((id) => {
        if (!shapes.has(id))
          conflict("missing_node", `Shape ${id} does not exist.`);
        shapes.delete(id);
      });
      edges.forEach((edge, id) => {
        if (
          remove.has(String(edge.get("from"))) ||
          remove.has(String(edge.get("to")))
        )
          edges.delete(id);
      });
      return;
    }
    case "insertEdges": {
      const { shapes, edges } = canvas(doc, command.canvasId);
      command.edges.forEach((edge) => {
        if (edges.has(edge.id))
          conflict("duplicate_id", `Edge ${edge.id} exists.`);
        if (!shapes.has(edge.from) || !shapes.has(edge.to))
          conflict("dangling_edge", `Edge ${edge.id} has a missing endpoint.`);
        edges.set(
          edge.id,
          encodeEdge(
            edge,
            keyBetween(
              [...edges.values()]
                .map((v) => String(v.get("orderKey")))
                .sort()
                .at(-1) ?? null,
              null,
            ),
          ),
        );
      });
      return;
    }
    case "updateEdges": {
      const { shapes, edges } = canvas(doc, command.canvasId);
      command.patches.forEach(({ id, patch }) => {
        const value = edges.get(id);
        if (!value) conflict("missing_node", `Edge ${id} does not exist.`);
        for (const [key, next] of Object.entries(patch)) {
          if ((key === "from" || key === "to") && !shapes.has(String(next)))
            conflict("dangling_edge", `Edge ${id} has a missing endpoint.`);
          if (key === "label") {
            const text = value.get("label") as Y.Text;
            text.delete(0, text.length);
            text.insert(0, String(next));
          } else value.set(key, nmlYSharedValue(next));
        }
      });
      return;
    }
    case "removeEdges": {
      const { edges } = canvas(doc, command.canvasId);
      command.edgeIds.forEach((id) => {
        if (!edges.has(id))
          conflict("missing_node", `Edge ${id} does not exist.`);
        edges.delete(id);
      });
      return;
    }
    default:
      return conflict(
        "invalid_command",
        `Unknown command type ${(command as { type?: unknown }).type}.`,
      );
  }
}

function findDecoded(doc: Y.Doc, id: string): NmlBlock {
  const stack = [...decodeNmlDocument(doc).blocks];
  while (stack.length) {
    const item = stack.shift()!;
    if (item.id === id) return item;
    stack.unshift(...item.children);
  }
  return conflict("missing_node", `Node ${id} does not exist.`);
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function fingerprint(commands: NmlCommand[]): string {
  return JSON.stringify(commands);
}
function resolveTemps<T>(value: T, mapping: Record<string, string>): T {
  if (typeof value === "string") return (mapping[value] ?? value) as T;
  if (Array.isArray(value))
    return value.map((item) => resolveTemps(item, mapping)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveTemps(v, mapping)]),
    ) as T;
  return value;
}

function insertedPlainText(content: NmlInlineContent): string | null {
  if (!content.every((node) => node.type === "text" && node.marks.length === 0)) return null;
  return content.map((node) => node.type === "text" ? node.text : "").join("");
}

function replaceSharedPlainText(
  index: NmlYjsIndex,
  nodeId: string,
  range: NmlRange,
  inserted: string,
): void {
  const target = index.plainText(nodeId);
  if (!target) conflict("incompatible_node", `Node ${nodeId} is not an unmarked plain-text block.`);
  let at = 0;
  for (const textNode of target.textNodes) {
    const length = textNode.length;
    const from = Math.max(0, range.from - at);
    const to = Math.min(length, range.to - at);
    if (to > from) textNode.delete(from, to - from);
    at += length;
  }
  if (!inserted) return;
  const afterDelete = index.plainText(nodeId);
  if (!afterDelete) conflict("incompatible_node", `Node ${nodeId} left the plain-text encoding.`);
  let remaining = range.from;
  let insertion: { node: Y.XmlText; offset: number } | null = null;
  for (const textNode of afterDelete.textNodes) {
    if (remaining <= textNode.length) {
      insertion = { node: textNode, offset: remaining };
      break;
    }
    remaining -= textNode.length;
  }
  if (!insertion) {
    const node = new Y.XmlText();
    afterDelete.fragment.insert(afterDelete.fragment.length, [node]);
    insertion = { node, offset: 0 };
  }
  insertion.node.insert(insertion.offset, inserted);
}

function executePlainTextFast(
  options: ExecuteNmlCommandsOptions,
): NmlCommandReceipt | null {
  const index = options.index;
  if (!index || !index.owns(options.doc) || !index.isCurrent() || options.commands.length === 0 || options.temporaryIds?.length ||
      !options.commands.every((command) => command.type === "replaceInline")) return null;

  const simulations = new Map<string, string>();
  const prepared: Array<{ command: Extract<NmlCommand, { type: "replaceInline" }>; inserted: string }> = [];
  for (const command of options.commands as Array<Extract<NmlCommand, { type: "replaceInline" }>>) {
    const target = index.plainText(command.nodeId);
    const inserted = insertedPlainText(command.content);
    if (!target || inserted === null) return null;
    const text = simulations.get(command.nodeId) ?? target.text;
    assertRange(command.range, text.length);
    if (!isGraphemeBoundary(text, command.range.from) || !isGraphemeBoundary(text, command.range.to)) {
      conflict("invalid_range", "Inline ranges cannot split a grapheme cluster.");
    }
    simulations.set(command.nodeId, text.slice(0, command.range.from) + inserted + text.slice(command.range.to));
    prepared.push({ command, inserted });
  }
  if (!index.allowsPlainText(simulations)) return null;

  const root = options.doc.getMap<unknown>(NML_YJS_ROOT);
  if (root.get("documentId") !== options.documentId) {
    conflict("document_mismatch", "Authorized document does not match canonical state.");
  }
  const receipts = options.doc.getMap<string>(RECEIPTS_ROOT);
  const rawFingerprint = fingerprint(options.commands);
  const prior = receipts.get(options.idempotencyKey);
  if (prior) {
    const parsed = JSON.parse(prior) as NmlCommandReceipt & { fingerprint: string };
    if (parsed.fingerprint !== rawFingerprint) conflict("idempotency_mismatch", "Idempotency key was already used for different commands.");
    const { fingerprint: _fingerprint, ...receipt } = parsed;
    return receipt;
  }
  if (options.preconditions?.stateVector && !bytesEqual(options.preconditions.stateVector, Y.encodeStateVector(options.doc))) {
    conflict("stale_state", "Document state no longer matches the precondition.");
  }
  for (const [id, state] of Object.entries(options.preconditions?.nodes ?? {})) {
    if ((state === "exists") !== !!index.block(id)) {
      conflict(state === "exists" ? "missing_node" : "duplicate_id", `Node ${id} violated its ${state} precondition.`);
    }
  }
  const receipt: NmlCommandReceipt = {
    status: "applied",
    idempotencyKey: options.idempotencyKey,
    transactionId: options.origin.transactionId,
    temporaryIds: {},
    commandCount: prepared.length,
  };
  options.doc.transact(() => {
    for (const { command, inserted } of prepared) {
      replaceSharedPlainText(index, command.nodeId, command.range, inserted);
    }
    receipts.set(options.idempotencyKey, JSON.stringify({ ...receipt, fingerprint: rawFingerprint }));
  }, options.origin);
  index.syncPlainText([...simulations.keys()]);
  return receipt;
}

export async function executeNmlCommands(
  options: ExecuteNmlCommandsOptions,
): Promise<NmlCommandReceipt> {
  const authorization = options.authorize({
    documentId: options.documentId,
    actor: options.origin.actor,
    access: "write",
  });
  const allowed = typeof authorization === "object" && authorization !== null && "then" in authorization
    ? await authorization
    : authorization;
  if (!allowed)
    conflict("unauthorized", "Write authorization was denied.");
  const fast = executePlainTextFast(options);
  if (fast) return fast;
  const current = decodeNmlDocument(options.doc);
  if (current.documentId !== options.documentId)
    conflict(
      "document_mismatch",
      "Authorized document does not match canonical state.",
    );
  const receipts = options.doc.getMap<string>(RECEIPTS_ROOT);
  const prior = receipts.get(options.idempotencyKey);
  const rawFingerprint = fingerprint(options.commands);
  if (prior) {
    const parsed = JSON.parse(prior) as NmlCommandReceipt & {
      fingerprint: string;
    };
    if (parsed.fingerprint !== rawFingerprint)
      conflict(
        "idempotency_mismatch",
        "Idempotency key was already used for different commands.",
      );
    const { fingerprint: _f, ...receipt } = parsed;
    return receipt;
  }
  if (
    options.preconditions?.stateVector &&
    !bytesEqual(
      options.preconditions.stateVector,
      Y.encodeStateVector(options.doc),
    )
  )
    conflict(
      "stale_state",
      "Document state no longer matches the precondition.",
    );
  const known = blockIndex(options.doc);
  for (const [id, state] of Object.entries(
    options.preconditions?.nodes ?? {},
  )) {
    if ((state === "exists") !== known.has(id))
      conflict(
        state === "exists" ? "missing_node" : "duplicate_id",
        `Node ${id} violated its ${state} precondition.`,
      );
  }
  const temporaryIds = Object.fromEntries(
    (options.temporaryIds ?? []).map((id, index) => [
      id,
      options.createId?.(id) ?? `${options.origin.transactionId}-${index + 1}`,
    ]),
  );
  const commands = resolveTemps(options.commands, temporaryIds);
  const staging = new Y.Doc();
  Y.applyUpdate(staging, Y.encodeStateAsUpdate(options.doc));
  try {
    staging.transact(
      () =>
        commands.forEach((command, index) => {
          try {
            apply(staging, command);
          } catch (error) {
            if (
              error instanceof NmlCommandConflict &&
              error.commandIndex === undefined
            )
              throw new NmlCommandConflict(error.code, error.message, index);
            throw error;
          }
        }),
      options.origin,
    );
    assertValidDocument(decodeNmlDocument(staging));
  } catch (error) {
    if (error instanceof NmlCommandConflict) throw error;
    if (error instanceof NmlValidationError)
      throw new NmlCommandConflict("invalid_command", error.message);
    throw error;
  }
  const receipt: NmlCommandReceipt = {
    status: "applied",
    idempotencyKey: options.idempotencyKey,
    transactionId: options.origin.transactionId,
    temporaryIds,
    commandCount: commands.length,
  };
  options.doc.transact(() => {
    commands.forEach(apply.bind(null, options.doc));
    receipts.set(
      options.idempotencyKey,
      JSON.stringify({ ...receipt, fingerprint: rawFingerprint }),
    );
  }, options.origin);
  if (options.index?.owns(options.doc) && !options.index.isCurrent()) {
    options.index.refresh(decodeNmlDocument(options.doc));
  }
  return receipt;
}
