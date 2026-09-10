import { EditorState, Plugin, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { Fragment, type Node as PmNode } from "prosemirror-model";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  executeNmlCommands,
  NmlCommandConflict,
  type ExecuteNmlCommandsOptions,
  type NmlCommand,
  type NmlCommandReceipt,
} from "../commands";
import {
  decodeNmlDocument,
  NmlYjsIndex,
  observeNmlChanges,
  type NmlChange,
  type NmlChangeSet,
  type NmlTransactionOrigin,
} from "../yjs";
import type { NmlBlock, NmlDocument } from "../schema";
import type { NmlInlineContent, NmlMark } from "../schema";
import { normalizeInline } from "../normalize";
import { serializeDocument } from "../serialize";
import {
  NML_LIST_TYPES,
  NmlProjection,
  NodeAdapterRegistry,
  canonicalBlocks,
  inlineFromPm,
  nmlInlineOffsetToPm,
  pmInlineOffsetToNml,
} from "./projection";
import { PositionIndex } from "./position-index";
import { translateProjectionTransaction } from "./translation";
import {
  parseAwarenessSelection,
  selectionFromNml,
  selectionToNml,
  serializeAwarenessSelection,
  type NmlSelection,
} from "./selection";

export type BridgeDiagnostic = {
  code: "invalid_source" | "unsupported_node" | "projection_drift" | "projection_failed" | "content_rejected" | "commit_rejected" | "composition_rejected" | "composition_recovered";
  nodeId?: string;
};
export type BridgeStatus = "ready" | "degraded" | "frozen" | "destroyed";
export type BridgeRequestUpdate = {
  requestId: string;
  status: "optimistic" | "acknowledged" | "reconciled" | "rejected";
  transactionId?: string;
};
export type BridgeUpdate = {
  state: EditorState;
  transaction: Transaction | null;
  changedNodeIds: string[];
  request?: BridgeRequestUpdate;
  awarenessClientIds?: number[];
  composition?: { status: "started" | "ended" | "recovered"; nodeId: string };
};
export type BridgePerformance = {
  fullObserverDecodes: number;
  fullProjections: number;
  incrementalTextTransactions: number;
  lastIndexNodesVisited: number;
  yjsIndexScans: number;
};
export type EditableBridgeOptions = {
  actor: NmlTransactionOrigin["actor"];
  authorize: ExecuteNmlCommandsOptions["authorize"];
  commit?: (options: ExecuteNmlCommandsOptions) => Promise<NmlCommandReceipt>;
  createRequestId?: () => string;
  awareness?: Awareness;
};
export type PlainTextBridgeOptions = EditableBridgeOptions;

type PendingRequest = {
  requestId: string;
  transactionId: string;
  nodeIds: string[];
  selectionEpoch: number;
  selection?: IntendedSelection;
};

type IntendedSelection = { nodeId: string; anchor: number; head: number };

type TextDiff = { from: number; to: number; inserted: string };

type ActiveComposition = {
  nodeId: string;
  start: NmlSelection;
  from: number;
  to: number;
  visibleBaseText: string;
  needsFullReconcile: boolean;
};

export type CompositionRecovery = {
  nodeId: string;
  text: string;
};

const PLAIN_TEXT_TYPES = new Set<NmlBlock["type"]>(["paragraph", "heading", "quote"]);
const INLINE_BLOCK_TYPES = new Set<NmlBlock["type"]>([
  "paragraph", "heading", "quote", "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem",
]);

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
  return normalizeInline(result);
}

function mutableBlock(document: NmlDocument, nodeId: string): NmlBlock | undefined {
  const stack = [...document.blocks];
  while (stack.length) {
    const block = stack.shift()!;
    if (block.id === nodeId) return block;
    stack.unshift(...block.children);
  }
  return undefined;
}

function mutableSiblings(document: NmlDocument, nodeId: string): { siblings: NmlBlock[]; index: number; parentId: string | null } | null {
  const visit = (siblings: NmlBlock[], parentId: string | null): ReturnType<typeof mutableSiblings> => {
    const index = siblings.findIndex((block) => block.id === nodeId);
    if (index >= 0) return { siblings, index, parentId };
    for (const block of siblings) {
      const nested = visit(block.children, block.id);
      if (nested) return nested;
    }
    return null;
  };
  return visit(document.blocks, null);
}

function plainText(block: NmlBlock | undefined): string | null {
  if (!block || !PLAIN_TEXT_TYPES.has(block.type) || !("content" in block)) return null;
  if (!block.content.every((node) => node.type === "text" && node.marks.length === 0)) return null;
  return block.content.map((node) => node.type === "text" ? node.text : "").join("");
}

function pmPlainText(node: PmNode): string | null {
  let text = "";
  let valid = true;
  node.forEach((child) => {
    if (!child.isText || child.marks.length) valid = false;
    else text += child.text ?? "";
  });
  return valid ? text : null;
}

function inlineText(content: NmlInlineContent): string {
  return content.map((node) => node.type === "text"
    ? node.text
    : node.type === "link"
      ? inlineText(node.content)
      : "\uFFFC").join("");
}

function pmInlineContent(node: PmNode): NmlInlineContent | null {
  try {
    return inlineFromPm(NML_LIST_TYPES.has(node.type.name.replace(/^nml_/, "")) ? node.firstChild! : node);
  } catch {
    return null;
  }
}

function pmInlineText(node: PmNode): string | null {
  const content = pmInlineContent(node);
  return content ? inlineText(content) : null;
}

function textDiff(before: string, after: string): TextDiff | null {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let suffix = 0;
  while (suffix < before.length - from && suffix < after.length - from &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { from, to: before.length - suffix, inserted: after.slice(from, after.length - suffix) };
}

function replaceProjectedNode(node: PmNode, nodeId: string, replacement: PmNode): PmNode {
  const children: PmNode[] = [];
  let changed = false;
  node.forEach((child) => {
    if (child.attrs.nmlId === nodeId) {
      children.push(replacement);
      changed = child !== replacement;
      return;
    }
    const next = child.childCount ? replaceProjectedNode(child, nodeId, replacement) : child;
    children.push(next);
    changed ||= next !== child;
  });
  return changed ? node.copy(Fragment.fromArray(children)) : node;
}

/** A non-owning projection over an already-authorized canonical Y.Doc. */
export abstract class NmlViewBridge {
  readonly projection: NmlProjection;
  readonly index = new PositionIndex();
  private readonly yjsIndex: NmlYjsIndex;
  private readonly bridgeId: string;
  private current: EditorState;
  private source: NmlDocument | null = null;
  private blocks = new Map<string, NmlBlock>();
  private mode: BridgeStatus = "ready";
  private stop: () => void = () => {};
  private stopAwareness: () => void = () => {};
  private driftCount = 0;
  private listeners = new Set<(update: BridgeUpdate) => void>();
  private permitted = new WeakSet<Transaction>();
  private pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private temporarySequence = 0;
  private selectionEpoch = 0;
  private durableSelection: NmlSelection | null = null;
  private previousOrder: string[] = [];
  private composition: ActiveComposition | null = null;
  private recovery: CompositionRecovery | null = null;
  private counters = {
    fullObserverDecodes: 0,
    fullProjections: 0,
    incrementalTextTransactions: 0,
    lastIndexNodesVisited: 0,
  };

  protected constructor(
    private readonly doc: Y.Doc,
    private readonly diagnostics: (diagnostic: BridgeDiagnostic) => void = () => {},
    registry = new NodeAdapterRegistry(),
    private readonly editing: EditableBridgeOptions | null = null,
    private readonly editingScope: "plain" | "full" = "plain",
  ) {
    if (editing?.awareness && editing.awareness.doc !== doc) throw new Error("NML awareness must belong to the canonical Y.Doc.");
    this.bridgeId = `nml-bridge-${doc.clientID}-${Math.random().toString(36).slice(2)}`;
    this.projection = new NmlProjection(registry);
    let projected: PmNode;
    try {
      this.source = decodeNmlDocument(doc);
      projected = this.projection.project(this.source);
      this.counters.fullProjections++;
      this.blocks = canonicalBlocks(this.source);
      this.checkUnsupported(projected);
    } catch {
      this.mode = "frozen";
      this.report({ code: "invalid_source" });
      projected = this.projection.schema.nodes.doc.createChecked({ documentId: "unavailable", schemaVersion: 1 });
    }
    this.yjsIndex = new NmlYjsIndex(doc, this.source ?? undefined);
    this.current = EditorState.create({
      doc: projected,
      plugins: [new Plugin({
        filterTransaction: (transaction) => !transaction.docChanged || !!this.editing || this.permitted.has(transaction),
        props: { editable: () => this.isEditable() },
      })],
    });
    this.counters.lastIndexNodesVisited = this.index.update(projected);
    this.previousOrder = this.positionOrder();
    this.durableSelection = selectionToNml(this.current.selection, this.current.doc, this.index, this.yjsIndex);
    this.publishSelection();
    if (editing?.awareness) {
      const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = [...new Set([...added, ...updated, ...removed])].filter((id) => id !== doc.clientID);
        if (changed.length) this.emit({ state: this.current, transaction: null, changedNodeIds: [], awarenessClientIds: changed });
      };
      editing.awareness.on("change", onAwareness);
      this.stopAwareness = () => editing.awareness?.off("change", onAwareness);
    }
    if (this.source) {
      this.stop = observeNmlChanges(doc, (change) => this.receive(change), {
        initialDocument: this.source,
        index: this.yjsIndex,
        incrementalPlainText: true,
        onFullDecode: () => { this.counters.fullObserverDecodes++; },
      });
    }
  }

  get state(): EditorState { return this.current; }
  status(): BridgeStatus { return this.mode; }
  isEditable(): boolean { return !!this.editing && this.mode !== "frozen" && this.mode !== "destroyed"; }
  supportsRichEditing(): boolean { return this.isEditable() && this.editingScope === "full"; }
  performance(): BridgePerformance {
    return { ...this.counters, yjsIndexScans: this.yjsIndex.scanCount() };
  }
  getBlock(id: string): NmlBlock | undefined {
    const block = this.blocks.get(id);
    return block ? structuredClone(block) : undefined;
  }
  snapshot(): NmlDocument | null { return this.source ? structuredClone(this.source) : null; }
  private temporaryId(kind: string): string {
    return `$nml-${kind}-${this.doc.clientID}-${++this.temporarySequence}`;
  }
  private addTemporaryProjectionIds(transaction: Transaction): Transaction {
    const seen = new Set<string>();
    let changed = false;
    const visit = (node: PmNode): PmNode => {
      if (node.isText) return node;
      const children: PmNode[] = [];
      node.forEach((child) => children.push(visit(child)));
      const hasIdentity = Object.prototype.hasOwnProperty.call(node.attrs, "nmlId");
      const currentId = hasIdentity && typeof node.attrs.nmlId === "string" && node.attrs.nmlId.length
        ? node.attrs.nmlId as string
        : null;
      const nmlId = hasIdentity && (!currentId || seen.has(currentId))
        ? this.temporaryId(node.type.name.replace(/^nml_/, ""))
        : currentId;
      if (nmlId) seen.add(nmlId);
      const nextAttrs = hasIdentity && nmlId !== currentId ? { ...node.attrs, nmlId } : node.attrs;
      const content = children.length ? Fragment.fromArray(children) : node.content;
      if (nextAttrs !== node.attrs || !content.eq(node.content)) changed = true;
      return node.type.createChecked(nextAttrs, content, node.marks);
    };
    const normalized = visit(transaction.doc);
    if (!changed) return transaction;
    const replacement = this.current.tr.replaceWith(0, this.current.doc.content.size, normalized.content);
    replacement.setSelection(Selection.fromJSON(replacement.doc, transaction.selection.toJSON()));
    return replacement;
  }
  private selectedInlineBlock(): {
    block: Extract<NmlBlock, { content: NmlInlineContent }>;
    nodeId: string;
    from: number;
    to: number;
  } | null {
    if (!this.source) return null;
    const find = (position: number) => {
      let entry = this.index.nodeAt(position) ?? (position > 0 ? this.index.nodeAt(position - 1) : null);
      while (entry) {
        const block = this.blocks.get(entry.nodeId);
        if (block && "content" in block && INLINE_BLOCK_TYPES.has(block.type)) return { entry, block };
        entry = entry.parentId ? this.index.get(entry.parentId) ?? null : null;
      }
      return null;
    };
    const anchor = find(this.current.selection.anchor);
    const head = find(this.current.selection.head);
    if (!anchor || !head || anchor.block.id !== head.block.id || anchor.entry.contentStart === undefined) return null;
    const node = this.current.doc.nodeAt(anchor.entry.pmStart);
    if (!node) return null;
    return {
      block: anchor.block as Extract<NmlBlock, { content: NmlInlineContent }>,
      nodeId: anchor.block.id,
      from: pmInlineOffsetToNml(node, Math.min(this.current.selection.anchor, this.current.selection.head) - anchor.entry.contentStart),
      to: pmInlineOffsetToNml(node, Math.max(this.current.selection.anchor, this.current.selection.head) - anchor.entry.contentStart),
    };
  }
  private commitDocument(
    document: NmlDocument,
    commands: NmlCommand[],
    changedNodeIds: string[],
    commandName: string,
    temporaryIds: string[] = [],
    selection?: IntendedSelection,
  ): boolean {
    try {
      this.selectionEpoch++;
      const projected = this.projection.project(document);
      const transaction = this.current.tr.replaceWith(0, this.current.doc.content.size, projected.content);
      if (!transaction.doc.eq(projected)) return false;
      if (selection) {
        const index = new PositionIndex();
        index.update(projected);
        const entry = index.get(selection.nodeId);
        if (entry?.contentStart !== undefined) {
          const node = transaction.doc.nodeAt(entry.pmStart);
          transaction.setSelection(TextSelection.create(
            transaction.doc,
            entry.contentStart + (node ? nmlInlineOffsetToPm(node, selection.anchor) : selection.anchor),
            entry.contentStart + (node ? nmlInlineOffsetToPm(node, selection.head) : selection.head),
          ));
        }
      }
      return this.commitCommands(changedNodeIds, commands, transaction, commandName, temporaryIds, selection);
    } catch {
      this.report({ code: "content_rejected", nodeId: changedNodeIds[0] });
      return false;
    }
  }
  dispatchCommands(commands: NmlCommand[], changedNodeIds: string[], temporaryIds: string[] = []): boolean {
    return this.supportsRichEditing() && this.commitCommands(changedNodeIds, commands, null, "domain-edit", temporaryIds);
  }
  toggleMark(mark: NmlMark): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || target.from === target.to) return false;
    const entry = this.index.get(target.nodeId);
    if (!entry?.contentStart) return false;
    const node = this.current.doc.nodeAt(entry.pmStart);
    if (!node) return false;
    const type = this.projection.schema.marks[mark];
    const from = entry.contentStart + nmlInlineOffsetToPm(node, target.from, "after");
    const to = entry.contentStart + nmlInlineOffsetToPm(node, target.to, "before");
    const active = this.current.doc.rangeHasMark(from, to, type);
    return this.dispatch(active ? this.current.tr.removeMark(from, to, type) : this.current.tr.addMark(from, to, type.create()));
  }
  setLink(href: string | null): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || target.from === target.to || !this.source) return false;
    const selected = sliceInline(target.block.content, target.from, target.to);
    const text = selected.flatMap((node) => node.type === "text" ? [node] : node.type === "link" ? node.content : []);
    if (!text.length || selected.some((node) => node.type !== "text" && node.type !== "link")) return false;
    const inserted: NmlInlineContent = href
      ? [{ type: "link", href, content: normalizeInline(text).filter(
        (node): node is Extract<NmlInlineContent[number], { type: "text" }> => node.type === "text",
      ) }]
      : normalizeInline(text);
    const desired = structuredClone(this.source);
    const block = mutableBlock(desired, target.nodeId);
    if (!block || !("content" in block)) return false;
    block.content = normalizeInline([
      ...sliceInline(block.content, 0, target.from),
      ...inserted,
      ...sliceInline(block.content, target.to, inlineLength(block.content)),
    ]);
    return this.commitDocument(
      desired,
      [{
        type: "setInlineLink",
        nodeId: target.nodeId,
        range: { from: target.from, to: target.to },
        href,
        ...(href ? { linkKey: this.temporaryId("link-run") } : {}),
      }],
      [target.nodeId],
      href ? "set-link" : "remove-link",
      [],
      { nodeId: target.nodeId, anchor: target.from, head: target.to },
    );
  }
  insertInlineMath(latex: string): boolean {
    if (this.editingScope !== "full") return false;
    const id = this.temporaryId("math");
    return this.dispatch(this.current.tr.replaceSelectionWith(
      this.projection.schema.nodes.math.createChecked({ nmlId: id, latex }),
    ));
  }
  insertPageReference(pageId: string, fallbackTitle: string): boolean {
    if (this.editingScope !== "full") return false;
    const id = this.temporaryId("ref");
    return this.dispatch(this.current.tr.replaceSelectionWith(
      this.projection.schema.nodes.pageRef.createChecked({ nmlId: id, pageId, fallbackTitle }),
    ));
  }
  splitSelection(): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || target.from !== target.to || !this.source) return false;
    const desired = structuredClone(this.source);
    const location = mutableSiblings(desired, target.nodeId);
    const block = mutableBlock(desired, target.nodeId);
    if (!location || !block || !("content" in block)) return false;
    const id = this.temporaryId("block");
    const right = {
      ...structuredClone(block),
      id,
      content: sliceInline(block.content, target.from, inlineLength(block.content)),
      children: [],
    } as NmlBlock;
    block.content = sliceInline(block.content, 0, target.from);
    location.siblings.splice(location.index + 1, 0, right);
    return this.commitDocument(
      desired,
      [{ type: "splitTextBlock", nodeId: target.nodeId, offset: target.from, newNodeId: id }],
      [target.nodeId, id],
      "split-block",
      [id],
      { nodeId: id, anchor: 0, head: 0 },
    );
  }
  joinBackward(): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || target.from !== 0 || target.to !== 0 || !this.source) return false;
    const desired = structuredClone(this.source);
    const location = mutableSiblings(desired, target.nodeId);
    if (!location || location.index === 0) return false;
    const right = location.siblings[location.index];
    const left = location.siblings[location.index - 1];
    if (!("content" in left) || !("content" in right) || left.children.length || right.children.length) return false;
    const offset = inlineLength(left.content);
    left.content = normalizeInline([...left.content, ...right.content]);
    location.siblings.splice(location.index, 1);
    return this.commitDocument(
      desired,
      [{ type: "joinTextBlocks", leftId: left.id, rightId: right.id }],
      [left.id, right.id],
      "join-blocks",
      [],
      { nodeId: left.id, anchor: offset, head: offset },
    );
  }
  indentSelection(outdent = false): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || !this.source) return false;
    const desired = structuredClone(this.source);
    const location = mutableSiblings(desired, target.nodeId);
    if (!location) return false;
    let parentId: string | null;
    let anchor: { afterId: string } | undefined;
    if (!outdent) {
      const previous = location.siblings[location.index - 1];
      if (!previous || !INLINE_BLOCK_TYPES.has(previous.type) || !previous.type.endsWith("ListItem")) return false;
      const [block] = location.siblings.splice(location.index, 1);
      previous.children.push(block);
      parentId = previous.id;
      anchor = previous.children.length > 1 ? { afterId: previous.children.at(-2)!.id } : undefined;
    } else {
      if (location.parentId === null) return false;
      const parentLocation = mutableSiblings(desired, location.parentId);
      const parent = mutableBlock(desired, location.parentId);
      if (!parentLocation || !parent || !parent.type.endsWith("ListItem")) return false;
      const [block] = location.siblings.splice(location.index, 1);
      parentLocation.siblings.splice(parentLocation.index + 1, 0, block);
      parentId = parentLocation.parentId;
      anchor = { afterId: parent.id };
    }
    return this.commitDocument(
      desired,
      [{ type: "moveNodes", nodeIds: [target.nodeId], destination: { parentId, anchor } }],
      [target.nodeId],
      outdent ? "outdent-block" : "indent-block",
      [],
      { nodeId: target.nodeId, anchor: target.from, head: target.from },
    );
  }
  moveSelection(direction: -1 | 1): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || !this.source) return false;
    const desired = structuredClone(this.source);
    const location = mutableSiblings(desired, target.nodeId);
    if (!location) return false;
    const destination = location.index + direction;
    if (destination < 0 || destination >= location.siblings.length) return false;
    const [block] = location.siblings.splice(location.index, 1);
    location.siblings.splice(destination, 0, block);
    const anchor = direction < 0
      ? { beforeId: location.siblings[destination + 1].id }
      : { afterId: location.siblings[destination - 1].id };
    return this.commitDocument(
      desired,
      [{ type: "moveNodes", nodeIds: [target.nodeId], destination: { parentId: location.parentId, anchor } }],
      [target.nodeId],
      "move-block",
      [],
      { nodeId: target.nodeId, anchor: target.from, head: target.from },
    );
  }
  setSelectedBlockType(
    blockType: Extract<NmlCommand, { type: "setTextBlockType" }>["blockType"],
    props?: Record<string, unknown>,
  ): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || !this.source) return false;
    const desired = structuredClone(this.source);
    const block = mutableBlock(desired, target.nodeId);
    if (!block || !("content" in block) || (block.children.length && !blockType.endsWith("ListItem"))) return false;
    const nextProps = props ?? (blockType === "heading" ? { level: 2 } : blockType === "checkListItem" ? { checked: false } : {});
    block.type = blockType;
    block.props = nextProps as typeof block.props;
    return this.commitDocument(
      desired,
      [{ type: "setTextBlockType", nodeId: target.nodeId, blockType, props: nextProps }],
      [target.nodeId],
      "set-block-type",
      [],
      { nodeId: target.nodeId, anchor: target.from, head: target.from },
    );
  }
  pasteText(text: string): boolean {
    if (this.editingScope !== "full") return false;
    const target = this.selectedInlineBlock();
    if (!target || !this.source) return false;
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length === 1) {
      const entry = this.index.get(target.nodeId);
      const node = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
      return !!entry?.contentStart && !!node && this.dispatch(this.current.tr.insertText(
        text,
        entry.contentStart + nmlInlineOffsetToPm(node, target.from, "after"),
        entry.contentStart + nmlInlineOffsetToPm(node, target.to, "before"),
      ));
    }
    const desired = structuredClone(this.source);
    const location = mutableSiblings(desired, target.nodeId);
    const block = mutableBlock(desired, target.nodeId);
    if (!location || !block || !("content" in block)) return false;
    const before = sliceInline(block.content, 0, target.from);
    const after = sliceInline(block.content, target.to, inlineLength(block.content));
    block.content = normalizeInline([...before, ...(lines[0] ? [{ type: "text" as const, text: lines[0], marks: [] as NmlMark[] }] : [])]);
    const inserted = lines.slice(1).map((line, index) => ({
      ...structuredClone(block),
      id: this.temporaryId("paste"),
      content: normalizeInline([
        ...(line ? [{ type: "text" as const, text: line, marks: [] as NmlMark[] }] : []),
        ...(index === lines.length - 2 ? after : []),
      ]),
      children: [],
    })) as NmlBlock[];
    location.siblings.splice(location.index + 1, 0, ...inserted);
    const commands: NmlCommand[] = [
      {
        type: "replaceInline",
        nodeId: target.nodeId,
        range: { from: target.from, to: inlineLength(target.block.content) },
        content: lines[0] ? [{ type: "text", text: lines[0], marks: [] }] : [],
      },
      { type: "insertNodes", parentId: location.parentId, anchor: { afterId: target.nodeId }, nodes: structuredClone(inserted) },
    ];
    return this.commitDocument(
      desired,
      commands,
      [target.nodeId, ...inserted.map((node) => node.id)],
      "paste-blocks",
      inserted.map((node) => node.id),
      { nodeId: inserted.at(-1)!.id, anchor: lines.at(-1)!.length, head: lines.at(-1)!.length },
    );
  }
  nmlSelection(): NmlSelection | null { return this.durableSelection ? structuredClone(this.durableSelection) : null; }
  toNmlSelection(selection: Selection = this.current.selection): NmlSelection | null {
    return selectionToNml(selection, this.current.doc, this.index, this.yjsIndex);
  }
  toPmSelection(selection: NmlSelection): Selection {
    return selectionFromNml(selection, this.current.doc, this.index, this.yjsIndex, this.previousOrder);
  }
  remoteSelections(): ReadonlyMap<number, Selection> {
    const result = new Map<number, Selection>();
    const awareness = this.editing?.awareness;
    if (!awareness) return result;
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const selection = parseAwarenessSelection((state as { nmlSelection?: unknown }).nmlSelection);
      if (selection) result.set(clientId, this.toPmSelection(selection));
    }
    return result;
  }
  compositionRecovery(): CompositionRecovery | null {
    return this.recovery ? { ...this.recovery } : null;
  }
  clearCompositionRecovery(): void {
    if (!this.recovery || this.mode === "destroyed") return;
    this.recovery = null;
    this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
  }
  subscribe(listener: (update: BridgeUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  reportViewFailure(nodeId: string): void {
    if (this.mode === "destroyed") return;
    this.mode = "frozen";
    this.report({ code: "projection_failed", nodeId });
    this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
  }
  private report(diagnostic: BridgeDiagnostic): void {
    try { this.diagnostics(diagnostic); } catch { /* Diagnostics never interrupt canonical work. */ }
  }
  private positionOrder(): string[] {
    return [...this.index.byId.values()]
      .sort((left, right) => left.pmStart - right.pmStart || right.pmEnd - left.pmEnd)
      .map((entry) => entry.nodeId);
  }
  private publishSelection(): void {
    const awareness = this.editing?.awareness;
    if (!awareness || this.mode === "destroyed") return;
    awareness.setLocalStateField("nmlSelection", this.durableSelection ? serializeAwarenessSelection(this.durableSelection) : null);
  }
  private rememberSelection(): void {
    if (this.composition || this.pending.size) return;
    this.durableSelection = this.toNmlSelection();
    this.publishSelection();
  }
  private restoreDurableSelection(transaction: Transaction): void {
    if (!this.durableSelection || this.pending.size || this.composition) return;
    const selection = selectionFromNml(this.durableSelection, transaction.doc, this.index, this.yjsIndex, this.previousOrder);
    if (!transaction.selection.eq(selection)) transaction.setSelection(selection);
  }
  private emit(update: BridgeUpdate): void {
    for (const listener of this.listeners) {
      try { listener(update); } catch { this.mode = "frozen"; this.report({ code: "projection_failed" }); }
    }
  }
  private checkUnsupported(node: PmNode): void {
    node.descendants((child) => {
      if (child.type.name !== "unsupported") return;
      this.mode = "degraded";
      this.report({ code: "unsupported_node", nodeId: child.attrs.nmlId });
    });
  }

  private translatePlainText(transaction: Transaction): { nodeId: string; command: NmlCommand } | null {
    if (transaction.steps.length !== 1) return null;
    const json = transaction.steps[0].toJSON() as { stepType?: string; from?: number; to?: number };
    if (json.stepType !== "replace" || typeof json.from !== "number" || typeof json.to !== "number") return null;
    const entry = this.index.nodeAt(json.from) ?? (json.from > 0 ? this.index.nodeAt(json.from - 1) : null);
    if (!entry?.contentStart || json.from < entry.contentStart || json.to > entry.pmEnd - 1) return null;
    const block = this.blocks.get(entry.nodeId);
    const canonical = plainText(block);
    if (canonical === null) return null;
    const before = this.current.doc.nodeAt(entry.pmStart);
    const after = transaction.doc.nodeAt(entry.pmStart);
    if (!before || !after || !before.sameMarkup(after)) return null;
    const beforeText = pmInlineText(before);
    const afterText = pmInlineText(after);
    if (beforeText === null || afterText === null || beforeText !== canonical) return null;
    if (transaction.doc.content.size - this.current.doc.content.size !== afterText.length - beforeText.length) return null;

    const from = json.from - entry.contentStart;
    const to = json.to - entry.contentStart;
    const insertedLength = afterText.length - (beforeText.length - (to - from));
    if (insertedLength < 0) return null;
    const inserted = afterText.slice(from, from + insertedLength);
    if (beforeText.slice(0, from) + inserted + beforeText.slice(to) !== afterText) return null;
    return {
      nodeId: entry.nodeId,
      command: {
        type: "replaceInline",
        nodeId: entry.nodeId,
        range: { from, to },
        content: inserted ? [{ type: "text", text: inserted, marks: [] }] : [],
      },
    };
  }

  private compositionText(transaction: Transaction): string | null {
    const composition = this.composition;
    if (!composition || transaction.steps.length !== 1) return null;
    const json = transaction.steps[0].toJSON() as { stepType?: string; from?: number; to?: number };
    const entry = this.index.get(composition.nodeId);
    if (!entry?.contentStart || json.stepType !== "replace" || typeof json.from !== "number" || typeof json.to !== "number" ||
      json.from < entry.contentStart || json.to > entry.pmEnd - 1) return null;
    const before = this.current.doc.nodeAt(entry.pmStart);
    const after = transaction.doc.nodeAt(entry.pmStart);
    if (!before || !after || !before.sameMarkup(after)) return null;
    const beforeText = pmInlineText(before);
    const afterText = pmInlineText(after);
    if (beforeText === null || afterText === null) return null;
    if (transaction.doc.content.size - this.current.doc.content.size !== afterText.length - beforeText.length) return null;
    return afterText;
  }

  private commitCommands(
    nodeIds: string[],
    commands: NmlCommand[],
    transaction: Transaction | null,
    commandName: string,
    temporaryIds: string[] = [],
    selection?: IntendedSelection,
  ): boolean {
    if (!this.editing || !this.source || this.mode === "frozen" || this.mode === "destroyed" || this.pending.size || !commands.length) return false;
    const requestId = this.editing.createRequestId?.() ?? `request-${this.doc.clientID}-${++this.requestSequence}`;
    const transactionId = `transaction-${requestId}`;
    const pending: PendingRequest = {
      requestId,
      transactionId,
      nodeIds: [...new Set(nodeIds)],
      selectionEpoch: this.selectionEpoch,
      selection,
    };
    const stateVector = Y.encodeStateVector(this.doc);
    if (transaction) {
      transaction.setMeta("nmlBridge", { bridgeId: this.bridgeId, direction: "pm-optimistic", requestId });
      transaction.setMeta("addToHistory", false);
      this.current = this.current.apply(transaction);
      this.counters.lastIndexNodesVisited = commandName === "plain-text-edit"
        ? this.index.updateChanged(nodeIds, this.current.doc)
        : this.index.update(this.current.doc);
    }
    this.pending.set(requestId, pending);
    this.emit({ state: this.current, transaction, changedNodeIds: pending.nodeIds, request: { requestId, status: "optimistic" } });

    const origin: NmlTransactionOrigin = {
      version: 1,
      transactionId,
      requestId,
      actor: this.editing.actor,
      command: commandName,
    };
    const execute = this.editing.commit ?? executeNmlCommands;
    let result: Promise<NmlCommandReceipt>;
    try {
      result = execute({
        doc: this.doc,
        documentId: this.source.documentId,
        commands,
        origin,
        idempotencyKey: requestId,
        authorize: this.editing.authorize,
        temporaryIds,
        preconditions: {
          stateVector,
          nodes: Object.fromEntries(pending.nodeIds.filter((id) => this.blocks.has(id)).map((id) => [id, "exists" as const])),
        },
        index: this.yjsIndex,
      });
    } catch (error) {
      this.reject(requestId, error);
      return true;
    }
    void result.then((receipt) => this.restoreReceiptSelection(pending, receipt)).catch((error) => this.reject(requestId, error));
    return true;
  }

  private restoreReceiptSelection(request: PendingRequest, receipt: NmlCommandReceipt): void {
    const intended = request.selection;
    if (!intended || request.selectionEpoch !== this.selectionEpoch || this.mode === "destroyed" || this.mode === "frozen") return;
    const nodeId = receipt.temporaryIds[intended.nodeId] ?? intended.nodeId;
    const entry = this.index.get(nodeId);
    const node = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
    if (!entry?.contentStart || !node) return;
    const anchor = entry.contentStart + nmlInlineOffsetToPm(node, intended.anchor);
    const head = entry.contentStart + nmlInlineOffsetToPm(node, intended.head);
    const transaction = this.current.tr.setSelection(TextSelection.create(this.current.doc, anchor, head));
    this.current = this.current.apply(transaction);
    this.rememberSelection();
    this.emit({ state: this.current, transaction, changedNodeIds: [] });
  }

  beginComposition(): boolean {
    if (!this.editing || this.mode === "destroyed" || this.mode === "frozen" || this.pending.size) return false;
    if (this.composition) return true;
    const start = this.toNmlSelection();
    if (!start || start.anchor.kind !== "text" || start.head.kind !== "text" || start.anchor.nodeId !== start.head.nodeId) {
      this.report({ code: "composition_rejected" });
      return false;
    }
    const nodeId = start.anchor.nodeId;
    const entry = this.index.get(nodeId);
    const target = this.yjsIndex.text(nodeId);
    const node = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
    const block = this.blocks.get(nodeId);
    const projected = node ? pmInlineContent(node) : null;
    if (this.editingScope === "plain" && plainText(block) === null) {
      this.report({ code: "composition_rejected" });
      return false;
    }
    if (!entry?.contentStart || !target || !node || !block || !("content" in block) || !projected ||
        JSON.stringify(projected) !== JSON.stringify(block.content)) {
      this.report({ code: "composition_rejected", nodeId });
      return false;
    }
    const anchor = this.yjsIndex.resolveRelativeTextPosition(nodeId, start.anchor.relative);
    const head = this.yjsIndex.resolveRelativeTextPosition(nodeId, start.head.relative);
    if (anchor === null || head === null) return false;
    this.durableSelection = start;
    this.publishSelection();
    this.composition = {
      nodeId,
      start,
      from: Math.min(anchor, head),
      to: Math.max(anchor, head),
      visibleBaseText: target.text,
      needsFullReconcile: false,
    };
    this.emit({ state: this.current, transaction: null, changedNodeIds: [], composition: { status: "started", nodeId } });
    return true;
  }

  endComposition(): boolean {
    const composition = this.composition;
    if (!composition || this.mode === "destroyed" || this.mode === "frozen") return false;
    const entry = this.index.get(composition.nodeId);
    const node = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
    const visibleContent = node ? pmInlineContent(node) : null;
    const visible = visibleContent ? inlineText(visibleContent) : null;
    if (!entry?.contentStart || visible === null) {
      this.recoverComposition(composition);
      return false;
    }
    const local = textDiff(composition.visibleBaseText, visible);
    if (composition.needsFullReconcile) this.rebuildFromCanonical(true);
    this.composition = null;
    if (!local) {
      if (!composition.needsFullReconcile && plainText(this.blocks.get(composition.nodeId)) !== null) {
        this.installPlainText([composition.nodeId]);
      }
      this.rememberSelection();
      this.emit({ state: this.current, transaction: null, changedNodeIds: [], composition: { status: "ended", nodeId: composition.nodeId } });
      return true;
    }
    let from = local.from;
    let to = local.to;
    const source = this.blocks.get(composition.nodeId);
    const sourceText = source && "content" in source ? inlineText(source.content) : null;
    if (composition.needsFullReconcile || sourceText !== this.yjsIndex.text(composition.nodeId)?.text) {
      const anchor = composition.start.anchor.kind === "text"
        ? this.yjsIndex.resolveRelativeTextPosition(composition.nodeId, composition.start.anchor.relative)
        : null;
      const head = composition.start.head.kind === "text"
        ? this.yjsIndex.resolveRelativeTextPosition(composition.nodeId, composition.start.head.relative)
        : null;
      if (anchor === null || head === null) {
        this.recoverComposition(composition, local.inserted);
        return false;
      }
      from = Math.min(anchor, head);
      to = Math.max(anchor, head);
    }
    const command: NmlCommand = {
      type: "replaceInline",
      nodeId: composition.nodeId,
      range: { from, to },
      content: local.inserted && visibleContent
        ? sliceInline(visibleContent, local.from, local.from + local.inserted.length)
        : [],
    };
    const committed = this.commitCommands([composition.nodeId], [command], null, "ime-composition");
    if (!committed) {
      this.recoverComposition(composition, local.inserted);
      return false;
    }
    this.emit({ state: this.current, transaction: null, changedNodeIds: [], composition: { status: "ended", nodeId: composition.nodeId } });
    return true;
  }

  private recoverComposition(composition: ActiveComposition, text?: string): void {
    const entry = this.index.get(composition.nodeId);
    const node = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
    const currentText = node ? pmInlineText(node) : null;
    const recovered = text ?? (currentText === null ? "" : textDiff(composition.visibleBaseText, currentText)?.inserted ?? "");
    this.composition = null;
    this.recovery = { nodeId: composition.nodeId, text: recovered };
    this.report({ code: "composition_recovered", nodeId: composition.nodeId });
    this.emit({
      state: this.current,
      transaction: null,
      changedNodeIds: [],
      composition: { status: "recovered", nodeId: composition.nodeId },
    });
  }

  private rebuildFromCanonical(preserveComposition = false): void {
    const next = decodeNmlDocument(this.doc);
    let projected = this.projection.project(next);
    this.counters.fullProjections++;
    if (preserveComposition && this.composition) {
      const entry = this.index.get(this.composition.nodeId);
      const currentNode = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
      if (currentNode) projected = replaceProjectedNode(projected, this.composition.nodeId, currentNode);
    }
    const blocks = canonicalBlocks(next);
    const changedNodeIds = [...new Set([...this.blocks.keys(), ...blocks.keys()])]
      .filter((id) => JSON.stringify(this.blocks.get(id)) !== JSON.stringify(blocks.get(id)));
    this.source = next;
    this.blocks = blocks;
    this.mode = "ready";
    this.checkUnsupported(projected);
    this.install(projected, changedNodeIds);
  }

  dispatch(transaction: Transaction): boolean {
    if (this.mode === "destroyed" || this.mode === "frozen") return false;
    if (!transaction.before.eq(this.current.doc)) return false;
    this.selectionEpoch++;
    if (!transaction.docChanged) {
      if (transaction.selectionSet) this.pending.forEach((request) => { request.selection = undefined; });
      this.current = this.current.apply(transaction);
      this.rememberSelection();
      this.emit({ state: this.current, transaction, changedNodeIds: [] });
      return true;
    }
    // ProseMirror can retain a replace step whose resulting document is identical
    // (for example, replacing a selected character with that same character).
    // Treat it as local view state so it cannot create a request with no Yjs text event.
    if (transaction.doc.eq(this.current.doc)) {
      this.current = this.current.apply(transaction);
      this.rememberSelection();
      this.emit({ state: this.current, transaction, changedNodeIds: [] });
      return true;
    }
    if (!this.editing || this.pending.size) {
      this.report({ code: "content_rejected" });
      return false;
    }
    if (this.composition) {
      const afterText = this.compositionText(transaction);
      if (afterText === null) {
        this.report({ code: "composition_rejected", nodeId: this.composition.nodeId });
        return false;
      }
      transaction.setMeta("nmlBridge", { bridgeId: this.bridgeId, direction: "pm-optimistic" });
      transaction.setMeta("addToHistory", false);
      const nodeId = this.composition.nodeId;
      this.current = this.current.apply(transaction);
      this.counters.lastIndexNodesVisited = this.index.updateChanged([nodeId], this.current.doc);
      this.emit({ state: this.current, transaction, changedNodeIds: [nodeId] });
      return true;
    }
    const translated = this.translatePlainText(transaction);
    if (translated) {
      return this.commitCommands([translated.nodeId], [translated.command], transaction, "plain-text-edit");
    }
    if (this.editingScope !== "full") {
      this.report({ code: "content_rejected" });
      return false;
    }
    if (!this.source) return false;
    try {
      transaction = this.addTemporaryProjectionIds(transaction);
      const result = translateProjectionTransaction(this.current.doc, transaction.doc, this.source, this.projection);
      if (!result.commands.length) {
        this.current = this.current.apply(transaction);
        this.counters.lastIndexNodesVisited = this.index.update(this.current.doc);
        this.rememberSelection();
        this.emit({ state: this.current, transaction, changedNodeIds: [] });
        return true;
      }
      return this.commitCommands(
        result.changedNodeIds,
        result.commands,
        transaction,
        "projection-edit",
        result.temporaryIds,
      );
    } catch {
      this.report({ code: "content_rejected" });
      return false;
    }
  }

  private updateSourcePlainText(nodeIds: readonly string[]): boolean {
    const rows = nodeIds.map((nodeId) => ({ nodeId, target: this.yjsIndex.plainText(nodeId), block: this.blocks.get(nodeId) }));
    if (rows.some(({ target, block }) => !target || !block || !("content" in block) || !PLAIN_TEXT_TYPES.has(block.type))) return false;
    for (const { target, block } of rows) {
      if (!target || !block || !("content" in block)) return false;
      block.content = target.text ? [{ type: "text", text: target.text, marks: [] }] : [];
    }
    return true;
  }

  private compositionIntersects(change: Extract<NmlChange, { kind: "text" }>): boolean {
    const composition = this.composition;
    if (!composition || change.nodeId !== composition.nodeId) return false;
    const range = change.range;
    if (!range) return true;
    if (range.from === range.to) return range.from >= composition.from && range.from <= composition.to;
    if (composition.from === composition.to) return range.from <= composition.from && range.to >= composition.to;
    return range.from < composition.to && range.to > composition.from;
  }

  private installCompositionText(nodeId: string): void {
    const composition = this.composition;
    const entry = this.index.get(nodeId);
    const target = this.yjsIndex.plainText(nodeId);
    const currentNode = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
    const currentText = currentNode ? pmPlainText(currentNode) : null;
    if (!composition || !entry?.contentStart || !target || currentText === null) throw new Error("Composition text mismatch");
    const remote = textDiff(composition.visibleBaseText, target.text);
    if (!remote) return;
    const local = textDiff(composition.visibleBaseText, currentText);
    const localDelta = local ? local.inserted.length - (local.to - local.from) : 0;
    const beforeComposition = remote.to <= composition.from;
    const from = remote.from + (beforeComposition ? 0 : localDelta);
    const to = remote.to + (beforeComposition ? 0 : localDelta);
    const transaction = this.current.tr.replaceWith(
      entry.contentStart + from,
      entry.contentStart + to,
      remote.inserted ? this.projection.schema.text(remote.inserted) : Fragment.empty,
    );
    transaction.setMeta("nmlBridge", { bridgeId: this.bridgeId, direction: "nml-to-pm" }).setMeta("addToHistory", false);
    this.permitted.add(transaction);
    this.current = this.current.apply(transaction);
    this.permitted.delete(transaction);
    this.counters.lastIndexNodesVisited = this.index.updateChanged([nodeId], this.current.doc);
    if (beforeComposition) {
      const delta = remote.inserted.length - (remote.to - remote.from);
      composition.from += delta;
      composition.to += delta;
    }
    composition.visibleBaseText = target.text;
    if (!this.updateSourcePlainText([nodeId])) throw new Error("Composition source mismatch");
    this.counters.incrementalTextTransactions++;
    this.emit({ state: this.current, transaction, changedNodeIds: [nodeId] });
  }

  private installPlainText(nodeIds: readonly string[], request?: PendingRequest): void {
    if (!this.updateSourcePlainText(nodeIds)) throw new Error("Incremental text source mismatch");
    const entries = nodeIds.map((nodeId) => ({ nodeId, entry: this.index.get(nodeId), target: this.yjsIndex.plainText(nodeId) }))
      .filter((row): row is { nodeId: string; entry: NonNullable<typeof row.entry>; target: NonNullable<typeof row.target> } => !!row.entry && !!row.target)
      .sort((a, b) => b.entry.pmStart - a.entry.pmStart);
    if (entries.length !== nodeIds.length) throw new Error("Incremental text position mismatch");
    let transaction: Transaction | null = null;
    for (const { entry, target } of entries) {
      const currentNode = (transaction?.doc ?? this.current.doc).nodeAt(entry.pmStart);
      const beforeText = currentNode ? pmPlainText(currentNode) : null;
      if (!currentNode || beforeText === null) throw new Error("Incremental PM text mismatch");
      if (beforeText === target.text) continue;
      let prefix = 0;
      while (prefix < beforeText.length && prefix < target.text.length && beforeText[prefix] === target.text[prefix]) prefix++;
      let suffix = 0;
      while (suffix < beforeText.length - prefix && suffix < target.text.length - prefix &&
        beforeText[beforeText.length - 1 - suffix] === target.text[target.text.length - 1 - suffix]) suffix++;
      const inserted = target.text.slice(prefix, target.text.length - suffix);
      transaction ??= this.current.tr;
      transaction.replaceWith(
        entry.contentStart! + prefix,
        entry.contentStart! + beforeText.length - suffix,
        inserted ? this.projection.schema.text(inserted) : Fragment.empty,
      );
    }
    if (request) this.pending.delete(request.requestId);
    if (transaction) {
      transaction.setMeta("nmlBridge", {
        bridgeId: this.bridgeId,
        direction: request ? "pm-reconcile" : "nml-to-pm",
        canonicalTransactionId: request?.transactionId,
        requestId: request?.requestId,
      }).setMeta("addToHistory", false);
      this.permitted.add(transaction);
      this.counters.lastIndexNodesVisited = this.index.updateChanged(nodeIds, transaction.doc);
      if (!request) this.restoreDurableSelection(transaction);
      this.current = this.current.apply(transaction);
      this.permitted.delete(transaction);
    }
    this.counters.incrementalTextTransactions++;
    if (!this.composition) this.rememberSelection();
    this.emit({
      state: this.current,
      transaction,
      changedNodeIds: [...nodeIds],
      ...(request ? { request: { requestId: request.requestId, transactionId: request.transactionId, status: transaction ? "reconciled" : "acknowledged" } } : {}),
    });
  }

  private install(projected: PmNode, changedNodeIds: string[], transactionId?: string, direction: "nml-to-pm" | "pm-reconcile" = "nml-to-pm", request?: BridgeRequestUpdate): void {
    const before = this.current.doc;
    const oldOrder = this.positionOrder();
    let transaction: Transaction | null = null;
    if (!before.eq(projected)) {
      transaction = this.current.tr;
      if (!before.sameMarkup(projected)) throw new Error("Canonical document identity changed");
      const start = before.content.findDiffStart(projected.content);
      if (start !== null) {
        const end = before.content.findDiffEnd(projected.content)!;
        const overlap = start - Math.min(end.a, end.b);
        if (overlap > 0) { end.a += overlap; end.b += overlap; }
        transaction.replace(start, end.a, projected.slice(start, end.b));
      }
      transaction.setMeta("nmlBridge", { bridgeId: this.bridgeId, direction, canonicalTransactionId: transactionId, requestId: request?.requestId }).setMeta("addToHistory", false);
      if (!transaction.doc.eq(projected)) throw new Error("Projection transaction mismatch");
      this.permitted.add(transaction);
      this.previousOrder = oldOrder;
      this.counters.lastIndexNodesVisited = this.index.update(transaction.doc);
      if (!request) this.restoreDurableSelection(transaction);
      this.current = this.current.apply(transaction);
      this.permitted.delete(transaction);
    }
    if (!this.composition) this.rememberSelection();
    this.emit({ state: this.current, transaction, changedNodeIds, ...(request ? { request } : {}) });
  }

  private receive(change: NmlChangeSet): void {
    if (this.mode === "destroyed" || this.mode === "frozen") return;
    if (change.diagnostics.length) {
      this.mode = "frozen";
      this.report({ code: "invalid_source" });
      this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
      return;
    }
    const request = change.origin?.requestId ? this.pending.get(change.origin.requestId) : undefined;
    const nodeIds = [...new Set(change.changes.filter((item) => item.kind === "text").map((item) => item.nodeId))];
    const onlyPlainText = change.changes.length > 0 && change.changes.every((item) => item.kind === "text") &&
      nodeIds.every((id) => this.yjsIndex.plainText(id) && plainText(this.blocks.get(id)) !== null);
    try {
      if (onlyPlainText) {
        if (this.composition && !request) {
          const textChanges = change.changes as Array<Extract<NmlChange, { kind: "text" }>>;
          const buffered = new Set(textChanges.filter((item) => this.compositionIntersects(item)).map((item) => item.nodeId));
          const ordinary = nodeIds.filter((id) => id !== this.composition?.nodeId);
          if (ordinary.length) this.installPlainText(ordinary);
          if (nodeIds.includes(this.composition.nodeId) && !buffered.has(this.composition.nodeId)) {
            this.installCompositionText(this.composition.nodeId);
          }
          return;
        }
        this.installPlainText(nodeIds, request);
        return;
      }
      const next = change.document ?? decodeNmlDocument(this.doc);
      const removedComposition = this.composition && change.changes.some((item) =>
        item.kind === "remove" && item.nodeIds.includes(this.composition!.nodeId));
      if (removedComposition && this.composition) this.recoverComposition(this.composition);
      const touchesComposition = this.composition && change.changes.some((item) =>
        ("nodeId" in item && item.nodeId === this.composition!.nodeId) ||
        ("nodeIds" in item && item.nodeIds.includes(this.composition!.nodeId)));
      if (touchesComposition && this.composition) {
        this.composition.needsFullReconcile = true;
        return;
      }
      let projected = this.projection.project(next);
      this.counters.fullProjections++;
      if (this.composition) {
        const entry = this.index.get(this.composition.nodeId);
        const currentNode = entry ? this.current.doc.nodeAt(entry.pmStart) : null;
        if (currentNode) projected = replaceProjectedNode(projected, this.composition.nodeId, currentNode);
      }
      const blocks = canonicalBlocks(next);
      const changedNodeIds = [...new Set([...this.blocks.keys(), ...blocks.keys()])].filter((id) => JSON.stringify(this.blocks.get(id)) !== JSON.stringify(blocks.get(id)));
      this.source = next;
      this.blocks = blocks;
      this.mode = "ready";
      this.checkUnsupported(projected);
      if (request) this.pending.delete(request.requestId);
      this.install(projected, changedNodeIds, change.transactionId, request ? "pm-reconcile" : "nml-to-pm", request ? {
        requestId: request.requestId,
        transactionId: request.transactionId,
        status: this.current.doc.eq(projected) ? "acknowledged" : "reconciled",
      } : undefined);
    } catch {
      this.mode = "frozen";
      this.report({ code: "projection_failed" });
      this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
    }
  }

  private reject(requestId: string, error: unknown): void {
    const request = this.pending.get(requestId);
    if (!request || this.mode === "destroyed") return;
    this.pending.delete(requestId);
    const nodeId = request.nodeIds[0];
    this.report({ code: "commit_rejected", ...(nodeId ? { nodeId } : {}) });
    if (error instanceof NmlCommandConflict && error.code === "unauthorized") this.report({ code: "content_rejected", ...(nodeId ? { nodeId } : {}) });
    if (!this.source) return;
    try {
      const projected = this.projection.project(this.source);
      this.counters.fullProjections++;
      this.install(projected, request.nodeIds, undefined, "pm-reconcile", { requestId, status: "rejected" });
    } catch {
      this.mode = "frozen";
      this.report({ code: "projection_failed", ...(nodeId ? { nodeId } : {}) });
      this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
    }
  }

  checkDrift(candidate = this.current.doc): boolean {
    if (!this.source || this.pending.size || this.composition || this.mode === "destroyed" || this.mode === "frozen") return false;
    try {
      const actual = this.projection.read(candidate, this.source);
      const freshIndex = new PositionIndex();
      freshIndex.update(candidate);
      const freshEntries = freshIndex.byId;
      const currentEntries = this.index.byId;
      const indexMatches = freshEntries.size === currentEntries.size && [...freshEntries].every(([id, entry]) => JSON.stringify(entry) === JSON.stringify(currentEntries.get(id)));
      if (serializeDocument(actual) === serializeDocument(this.source) && candidate.eq(this.current.doc) && indexMatches) return true;
    } catch { /* Rebuild once from canonical data. */ }
    this.report({ code: "projection_drift" });
    if (++this.driftCount > 1) {
      this.mode = "frozen";
      this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
      return false;
    }
    try {
      this.counters.lastIndexNodesVisited = this.index.update(this.current.doc);
      this.install(this.projection.project(this.source), [...this.blocks.keys()]);
      this.counters.fullProjections++;
    } catch {
      this.mode = "frozen";
      this.report({ code: "projection_failed" });
    }
    return false;
  }

  destroy(): void {
    this.stop();
    this.stopAwareness();
    if (this.editing?.awareness?.getLocalState()) this.editing.awareness.setLocalStateField("nmlSelection", null);
    this.pending.clear();
    this.composition = null;
    this.listeners.clear();
    this.mode = "destroyed";
  }
}

export class ReadOnlyNmlBridge extends NmlViewBridge {
  constructor(doc: Y.Doc, diagnostics: (diagnostic: BridgeDiagnostic) => void = () => {}, registry = new NodeAdapterRegistry()) {
    super(doc, diagnostics, registry);
  }
}

export class PlainTextNmlBridge extends NmlViewBridge {
  constructor(doc: Y.Doc, options: PlainTextBridgeOptions, diagnostics: (diagnostic: BridgeDiagnostic) => void = () => {}, registry = new NodeAdapterRegistry()) {
    super(doc, diagnostics, registry, options, "plain");
  }
}

export class EditableNmlBridge extends NmlViewBridge {
  constructor(doc: Y.Doc, options: EditableBridgeOptions, diagnostics: (diagnostic: BridgeDiagnostic) => void = () => {}, registry = new NodeAdapterRegistry()) {
    super(doc, diagnostics, registry, options, "full");
  }
}
