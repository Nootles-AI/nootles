import { Fragment, Schema, type Node as PmNode, type NodeSpec, type DOMOutputSpec } from "prosemirror-model";
import { NML_MARKS, type NmlBlock, type NmlDocument, type NmlInlineContent, type NmlMark } from "../schema";
import { normalizeDocument, normalizeInline } from "../normalize";
import { validateDocument } from "../validate";

export const BLOCK_TYPES = ["paragraph", "heading", "quote", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem", "table", "codeBlock", "mathBlock", "divider", "image", "video", "audio", "file", "canvas", "album", "storyboard", "location"] as const satisfies readonly NmlBlock["type"][];
const _coverage: Exclude<NmlBlock["type"], typeof BLOCK_TYPES[number]> extends never ? true : never = true;
void _coverage;
export const NML_LIST_TYPES = new Set<string>(["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"]);
export const NML_PROSE_TYPES = new Set<string>(["paragraph", "heading", "quote"]);
export const NML_INLINE_BLOCK_TYPES = new Set<string>([...NML_PROSE_TYPES, ...NML_LIST_TYPES]);
const identity = { nmlId: { default: null }, props: { default: {} } };

export type ProjectionContext = {
  schema: Schema;
  registry: NodeAdapterRegistry;
  getBlock: (id: string) => NmlBlock | undefined;
};
export interface NodeAdapter {
  nmlType: NmlBlock["type"];
  pmNodeType: string;
  spec: NodeSpec;
  toPmNode(block: NmlBlock, context: ProjectionContext, children: PmNode[]): PmNode;
  fromPmNode(node: PmNode, context: ProjectionContext, children: NmlBlock[]): NmlBlock;
}

export class NodeAdapterRegistry {
  private readonly adapters = new Map<string, NodeAdapter>();
  constructor(adapters: readonly NodeAdapter[] = BLOCK_TYPES.map(defaultAdapter)) {
    const names = new Set<string>();
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.nmlType) || names.has(adapter.pmNodeType)) throw new Error("Duplicate NML view adapter");
      this.adapters.set(adapter.nmlType, adapter);
      names.add(adapter.pmNodeType);
    }
  }
  get(type: string): NodeAdapter | undefined { return this.adapters.get(type); }
  values(): NodeAdapter[] { return [...this.adapters.values()]; }
}

function dom(block: NmlBlock["type"], node: PmNode): DOMOutputSpec {
  const attrs = { "data-nml-id": node.attrs.nmlId, "data-content-type": block };
  if (NML_PROSE_TYPES.has(block)) return ["div", { "data-nml-id": node.attrs.nmlId, class: "bn-block-outer" }, ["div", { class: "bn-block" }, ["div", { class: "bn-block-content", "data-content-type": block, ...(block === "heading" ? { "data-level": node.attrs.props.level } : {}) }, [block === "heading" ? `h${node.attrs.props.level}` : block === "quote" ? "blockquote" : "p", { class: "bn-inline-content" }, 0]]]];
  if (NML_LIST_TYPES.has(block)) return ["div", { ...attrs, "data-checked": String(node.attrs.props.checked ?? false), "data-start": `${node.attrs.viewOrdinal ?? 1}.` }, 0];
  if (block === "table") return ["table", attrs, ["tbody", 0]];
  if (block === "codeBlock") return ["pre", { ...attrs, class: "nt-code" }, ["code", 0]];
  if (block === "mathBlock") return ["div", { ...attrs, class: "nt-mathblock" }, 0];
  if (block === "divider") return ["hr", attrs];
  // Domain renderers are supplied by the browser host, never by the headless core.
  return ["div", { ...attrs, contenteditable: "false", role: "group", "aria-label": block }, block];
}

function defaultAdapter(type: NmlBlock["type"]): NodeAdapter {
  const pmNodeType = `nml_${type}`;
  const content = NML_PROSE_TYPES.has(type) ? "inline*" : NML_LIST_TYPES.has(type) ? "inline_body block_group?" : type === "table" ? "table_row*" : type === "codeBlock" ? "text*" : type === "mathBlock" ? "math_row*" : undefined;
  return {
    nmlType: type, pmNodeType,
    spec: {
      group: "block", attrs: { ...identity, ...(type === "numberedListItem" ? { viewOrdinal: { default: 1 } } : {}), ...(type === "table" ? { columns: {} } : {}), ...(["album", "storyboard", "location"].includes(type) ? { domain: {}, legacyMarkup: { default: null } } : {}) },
      content, atom: !NML_PROSE_TYPES.has(type) && !NML_LIST_TYPES.has(type) && type !== "table",
      ...(type === "codeBlock" ? { code: true, marks: "", whitespace: "pre" as const } : {}),
      toDOM: (node) => dom(type, node),
    },
    toPmNode(block, ctx, children) {
      const attrs: Record<string, unknown> = { nmlId: block.id, props: structuredClone(block.props) };
      let content: PmNode[] = [];
      if ("content" in block) {
        content = inlineToPm(block.content, ctx.schema);
        if (NML_LIST_TYPES.has(type)) content = [ctx.schema.nodes.inline_body.createChecked(null, content), ...(children.length ? [ctx.schema.nodes.block_group.createChecked(null, children)] : [])];
      } else if (block.type === "table") {
        attrs.columns = structuredClone(block.columns);
        content = block.rows.map((row, index) => ctx.schema.nodes.table_row.createChecked({ nmlId: row.id }, row.cells.map((cell) => ctx.schema.nodes.table_cell.createChecked({ nmlId: cell.id, viewHeader: index < block.props.headerRows }, inlineToPm(cell.content, ctx.schema)))));
      } else if (block.type === "codeBlock") content = block.code ? [ctx.schema.text(block.code)] : [];
      else if (block.type === "mathBlock") content = block.rows.map((row) => ctx.schema.nodes.math_row.createChecked({ nmlId: row.id }, row.latex ? ctx.schema.text(row.latex) : undefined));
      else if ("domain" in block) { attrs.domain = structuredClone(block.domain); attrs.legacyMarkup = block.legacyMarkup ?? null; }
      return ctx.schema.nodes[pmNodeType].createChecked(attrs, content);
    },
    fromPmNode(node, ctx, children) {
      const base = { id: node.attrs.nmlId as string, type, props: structuredClone(node.attrs.props), children };
      if (NML_PROSE_TYPES.has(type) || NML_LIST_TYPES.has(type)) return { ...base, content: inlineFromPm(NML_LIST_TYPES.has(type) ? node.firstChild! : node) } as NmlBlock;
      if (type === "table") {
        const rows: Array<{ id: string; cells: Array<{ id: string; content: NmlInlineContent }> }> = [];
        node.forEach((row) => {
          const cells: typeof rows[number]["cells"] = [];
          row.forEach((cell) => cells.push({ id: cell.attrs.nmlId, content: inlineFromPm(cell) }));
          rows.push({ id: row.attrs.nmlId, cells });
        });
        return { ...base, type, columns: structuredClone(node.attrs.columns), rows };
      }
      if (type === "codeBlock") return { ...base, type, code: node.textContent };
      if (type === "mathBlock") {
        const rows: Array<{ id: string; latex: string }> = [];
        node.forEach((row) => rows.push({ id: row.attrs.nmlId, latex: row.textContent }));
        return { ...base, type, rows };
      }
      if (type === "canvas") {
        const source = ctx.getBlock(base.id);
        if (source?.type !== "canvas") throw new Error("Missing canonical canvas domain");
        return { ...base, type, scene: structuredClone(source.scene) };
      }
      if (["album", "storyboard", "location"].includes(type)) return { ...base, domain: structuredClone(node.attrs.domain), ...(node.attrs.legacyMarkup === null ? {} : { legacyMarkup: node.attrs.legacyMarkup }) } as NmlBlock;
      return base as NmlBlock;
    },
  };
}

export function createProjectionSchema(registry = new NodeAdapterRegistry()): Schema {
  const nodes: Record<string, NodeSpec> = {
    doc: { content: "block*", attrs: { documentId: {}, schemaVersion: {} } },
    text: { group: "inline" },
    inline_body: { content: "inline*", toDOM: () => ["div", { "data-nml-wrapper": "inline" }, 0] },
    block_group: { content: "block*", toDOM: () => ["div", { "data-nml-wrapper": "children", style: "padding-left: 24px" }, 0] },
    // Links are inline containers to preserve adjacent equal-URL links exactly.
    link: { inline: true, group: "inline", content: "text*", attrs: { href: {} }, toDOM: (node) => ["a", { href: node.attrs.href, rel: "noopener noreferrer" }, 0] },
    math: { inline: true, group: "inline", atom: true, attrs: { nmlId: { default: null }, latex: {} }, toDOM: (node) => ["span", { "data-nml-id": node.attrs.nmlId, class: "nt-math-inline", contenteditable: "false" }, node.attrs.latex] },
    pageRef: { inline: true, group: "inline", atom: true, attrs: { nmlId: { default: null }, pageId: {}, fallbackTitle: {} }, toDOM: (node) => ["span", { "data-nml-id": node.attrs.nmlId, "data-page-id": node.attrs.pageId, class: "nt-ref", contenteditable: "false" }, node.attrs.fallbackTitle] },
    table_row: { content: "table_cell*", attrs: { nmlId: { default: null } }, toDOM: (node) => ["tr", { "data-nml-id": node.attrs.nmlId }, 0] },
    table_cell: { content: "inline*", attrs: { nmlId: { default: null }, viewHeader: { default: false } }, toDOM: (node) => [node.attrs.viewHeader ? "th" : "td", { "data-nml-id": node.attrs.nmlId }, 0] },
    math_row: { content: "text*", marks: "", attrs: { nmlId: { default: null } }, toDOM: (node) => ["div", { "data-nml-id": node.attrs.nmlId, class: "nt-mathblock-row" }, 0] },
    unsupported: { group: "block", atom: true, attrs: { nmlId: {}, payload: {} }, toDOM: (node) => ["div", { "data-nml-id": node.attrs.nmlId, "data-nml-unsupported": "true", contenteditable: "false", role: "note" }, "This block requires a compatible view."] },
  };
  for (const adapter of registry.values()) {
    if (nodes[adapter.pmNodeType]) throw new Error("Reserved projection node name");
    nodes[adapter.pmNodeType] = adapter.spec;
  }
  const tags = { code: "code", bold: "strong", italic: "em", strike: "s", underline: "u" };
  return new Schema({ nodes, marks: Object.fromEntries(NML_MARKS.map((mark) => [mark, { toDOM: (): DOMOutputSpec => [tags[mark], 0] }])) });
}

export function inlineToPm(content: NmlInlineContent, schema: Schema): PmNode[] {
  return content.flatMap((node): PmNode[] => {
    if (node.type === "text") return node.text ? [schema.text(node.text, node.marks.map((mark) => schema.marks[mark].create()))] : [];
    if (node.type === "link") return [schema.nodes.link.createChecked({ href: node.href }, inlineToPm(node.content, schema))];
    const { id, type, ...attrs } = node;
    return [schema.nodes[type].createChecked({ nmlId: id, ...attrs })];
  });
}

export function inlineFromPm(node: PmNode): NmlInlineContent {
  const result: NmlInlineContent = [];
  node.forEach((child) => {
    if (child.isText) result.push({ type: "text", text: child.text!, marks: child.marks.map((mark) => mark.type.name as NmlMark) });
    else if (child.type.name === "link") result.push({ type: "link", href: child.attrs.href, content: inlineFromPm(child) as Extract<NmlInlineContent[number], { type: "text" }>[] });
    else if (child.type.name === "math") result.push({ type: "math", id: child.attrs.nmlId, latex: child.attrs.latex });
    else if (child.type.name === "pageRef") result.push({ type: "pageRef", id: child.attrs.nmlId, pageId: child.attrs.pageId, fallbackTitle: child.attrs.fallbackTitle });
    else throw new Error("Unsupported inline projection");
  });
  return normalizeInline(result);
}

function inlineContainer(node: PmNode): PmNode {
  return NML_LIST_TYPES.has(node.type.name.replace(/^nml_/, "")) && node.firstChild?.type.name === "inline_body"
    ? node.firstChild
    : node;
}

function canonicalInlineNodeLength(node: PmNode): number {
  return node.type.name === "link" ? node.content.size : node.nodeSize;
}

/** Convert a position inside a projected inline container to the canonical NML offset. */
export function pmInlineOffsetToNml(node: PmNode, offset: number): number {
  const container = inlineContainer(node);
  const bounded = Math.max(0, Math.min(container.content.size, offset));
  let canonical = 0;
  let result = 0;
  container.forEach((child, pmStart) => {
    if (pmStart >= bounded) return;
    const length = canonicalInlineNodeLength(child);
    if (child.type.name === "link" && bounded < pmStart + child.nodeSize) {
      result = canonical + Math.max(0, Math.min(length, bounded - pmStart - 1));
    } else if (bounded < pmStart + child.nodeSize) {
      result = canonical + Math.max(0, Math.min(length, bounded - pmStart));
    } else {
      result = canonical + length;
    }
    canonical += length;
  });
  return result;
}

/** Convert a canonical NML inline offset back to its projected position. */
export function nmlInlineOffsetToPm(
  node: PmNode,
  offset: number,
  affinity: "before" | "after" = "after",
): number {
  const container = inlineContainer(node);
  let total = 0;
  container.forEach((child) => { total += canonicalInlineNodeLength(child); });
  const bounded = Math.max(0, Math.min(total, offset));
  let canonical = 0;
  let found = false;
  let result = container.content.size;
  container.forEach((child, pmStart) => {
    const length = canonicalInlineNodeLength(child);
    if (found || bounded > canonical + length) {
      canonical += length;
      return;
    }
    found = true;
    if (child.type.name !== "link") {
      result = pmStart + Math.max(0, Math.min(length, bounded - canonical));
      return;
    }
    const local = bounded - canonical;
    if (local <= 0) result = affinity === "after" ? pmStart + 1 : pmStart;
    else if (local >= length) result = affinity === "before" ? pmStart + 1 + length : pmStart + child.nodeSize;
    else result = pmStart + 1 + local;
  });
  return result;
}

export function canonicalBlocks(document: NmlDocument): Map<string, NmlBlock> {
  const result = new Map<string, NmlBlock>();
  const visit = (blocks: NmlBlock[]) => blocks.forEach((block) => { result.set(block.id, block); visit(block.children); });
  visit(document.blocks);
  return result;
}

type Cached = { signature: string; node: PmNode };
export class NmlProjection {
  readonly registry: NodeAdapterRegistry;
  readonly schema: Schema;
  private cache = new Map<string, Cached>();
  constructor(registry = new NodeAdapterRegistry()) { this.registry = registry; this.schema = createProjectionSchema(registry); }
  project(input: NmlDocument): PmNode {
    if (validateDocument(input).length) throw new Error("Invalid canonical document for projection");
    const document = normalizeDocument(input);
    const blocks = canonicalBlocks(document);
    const context: ProjectionContext = { schema: this.schema, registry: this.registry, getBlock: (id) => blocks.get(id) };
    const next = new Map<string, Cached>();
    const visitSiblings = (siblings: NmlBlock[]): PmNode[] => {
      let ordinal = 0;
      return siblings.map((block) => {
        ordinal = block.type === "numberedListItem" ? block.props.start ?? ordinal + 1 : 0;
        return visit(block, ordinal);
      });
    };
    const visit = (block: NmlBlock, ordinal: number): PmNode => {
      const adapter = this.registry.get(block.type);
      const children = visitSiblings(block.children);
      const { children: _children, ...own } = block;
      void _children;
      // A canvas scene never occupies PM attributes, even transiently.
      const signature = JSON.stringify(!adapter ? block : { ...(block.type === "canvas" ? { id: block.id, type: block.type, props: block.props } : own), childIds: block.children.map((child) => child.id), ordinal });
      const previous = this.cache.get(block.id);
      let candidate = previous?.signature === signature && block.children.every((child, i) => this.cache.get(child.id)?.node === children[i]) && (!NML_LIST_TYPES.has(block.type) || (previous.node.lastChild?.type.name === "block_group" ? previous.node.lastChild.childCount : 0) === children.length)
        ? previous.node
        : adapter ? adapter.toPmNode(block, context, children) : this.schema.nodes.unsupported.createChecked({ nmlId: block.id, payload: structuredClone(block) });
      if (adapter && block.type === "numberedListItem" && candidate.attrs.viewOrdinal !== ordinal) candidate = candidate.type.createChecked({ ...candidate.attrs, viewOrdinal: ordinal }, candidate.content);
      next.set(block.id, { signature, node: candidate });
      return candidate;
    };
    const result = this.schema.nodes.doc.createChecked({ documentId: document.documentId, schemaVersion: document.schemaVersion }, visitSiblings(document.blocks));
    result.check();
    this.cache = next;
    return result;
  }
  read(node: PmNode, source: NmlDocument): NmlDocument {
    if (node.type !== this.schema.nodes.doc) throw new Error("Foreign projection schema");
    node.check();
    const blocks = canonicalBlocks(source);
    const ctx: ProjectionContext = { schema: this.schema, registry: this.registry, getBlock: (id) => blocks.get(id) };
    const visit = (pm: PmNode): NmlBlock => {
      if (pm.type.name === "unsupported") {
        if (pm.attrs.payload.id !== pm.attrs.nmlId) throw new Error("Placeholder identity drift");
        return structuredClone(pm.attrs.payload);
      }
      const adapter = this.registry.values().find((entry) => entry.pmNodeType === pm.type.name);
      if (!adapter) throw new Error("Unknown projection node");
      const children: NmlBlock[] = [];
      if (NML_LIST_TYPES.has(adapter.nmlType) && pm.lastChild?.type.name === "block_group") pm.lastChild.forEach((child) => children.push(visit(child)));
      return adapter.fromPmNode(pm, ctx, children);
    };
    const result: NmlDocument = { documentId: node.attrs.documentId, schemaVersion: node.attrs.schemaVersion, blocks: [] };
    node.forEach((child) => result.blocks.push(visit(child)));
    if (validateDocument(result).length) throw new Error("Invalid reverse projection");
    return normalizeDocument(result);
  }
}

export { Fragment };
