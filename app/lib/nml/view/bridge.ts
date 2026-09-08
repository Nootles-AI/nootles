import { EditorState, Plugin, type Transaction } from "prosemirror-state";
import { Fragment, type Node as PmNode } from "prosemirror-model";
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
  type NmlChangeSet,
  type NmlTransactionOrigin,
} from "../yjs";
import type { NmlBlock, NmlDocument } from "../schema";
import { serializeDocument } from "../serialize";
import { NmlProjection, NodeAdapterRegistry, canonicalBlocks } from "./projection";
import { PositionIndex } from "./position-index";

export type BridgeDiagnostic = {
  code: "invalid_source" | "unsupported_node" | "projection_drift" | "projection_failed" | "content_rejected" | "commit_rejected";
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
};
export type BridgePerformance = {
  fullObserverDecodes: number;
  fullProjections: number;
  incrementalTextTransactions: number;
  lastIndexNodesVisited: number;
  yjsIndexScans: number;
};
export type PlainTextBridgeOptions = {
  actor: NmlTransactionOrigin["actor"];
  authorize: ExecuteNmlCommandsOptions["authorize"];
  commit?: (options: ExecuteNmlCommandsOptions) => Promise<NmlCommandReceipt>;
  createRequestId?: () => string;
};

type PendingRequest = {
  requestId: string;
  transactionId: string;
  nodeId: string;
};

const PLAIN_TEXT_TYPES = new Set<NmlBlock["type"]>(["paragraph", "heading", "quote"]);

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
  private driftCount = 0;
  private listeners = new Set<(update: BridgeUpdate) => void>();
  private permitted = new WeakSet<Transaction>();
  private pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
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
    private readonly editing: PlainTextBridgeOptions | null = null,
  ) {
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
  performance(): BridgePerformance {
    return { ...this.counters, yjsIndexScans: this.yjsIndex.scanCount() };
  }
  getBlock(id: string): NmlBlock | undefined {
    const block = this.blocks.get(id);
    return block ? structuredClone(block) : undefined;
  }
  snapshot(): NmlDocument | null { return this.source ? structuredClone(this.source) : null; }
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
    const beforeText = pmPlainText(before);
    const afterText = pmPlainText(after);
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

  dispatch(transaction: Transaction): boolean {
    if (this.mode === "destroyed" || this.mode === "frozen") return false;
    if (!transaction.before.eq(this.current.doc)) return false;
    if (!transaction.docChanged) {
      this.current = this.current.apply(transaction);
      this.emit({ state: this.current, transaction, changedNodeIds: [] });
      return true;
    }
    // ProseMirror can retain a replace step whose resulting document is identical
    // (for example, replacing a selected character with that same character).
    // Treat it as local view state so it cannot create a request with no Yjs text event.
    if (transaction.doc.eq(this.current.doc)) {
      this.current = this.current.apply(transaction);
      this.emit({ state: this.current, transaction, changedNodeIds: [] });
      return true;
    }
    if (!this.editing || this.pending.size) {
      this.report({ code: "content_rejected" });
      return false;
    }
    const translated = this.translatePlainText(transaction);
    if (!translated || !this.source) {
      this.report({ code: "content_rejected", nodeId: translated?.nodeId });
      return false;
    }

    const requestId = this.editing.createRequestId?.() ?? `request-${this.doc.clientID}-${++this.requestSequence}`;
    const transactionId = `transaction-${requestId}`;
    const pending = { requestId, transactionId, nodeId: translated.nodeId };
    const stateVector = Y.encodeStateVector(this.doc);
    transaction.setMeta("nmlBridge", { bridgeId: this.bridgeId, direction: "pm-optimistic", requestId });
    transaction.setMeta("addToHistory", false);
    this.pending.set(requestId, pending);
    this.current = this.current.apply(transaction);
    this.counters.lastIndexNodesVisited = this.index.updateChanged([translated.nodeId], this.current.doc);
    this.emit({ state: this.current, transaction, changedNodeIds: [translated.nodeId], request: { requestId, status: "optimistic" } });

    const origin: NmlTransactionOrigin = {
      version: 1,
      transactionId,
      requestId,
      actor: this.editing.actor,
      command: "plain-text-edit",
    };
    const execute = this.editing.commit ?? executeNmlCommands;
    let result: Promise<NmlCommandReceipt>;
    try {
      result = execute({
        doc: this.doc,
        documentId: this.source.documentId,
        commands: [translated.command],
        origin,
        idempotencyKey: requestId,
        authorize: this.editing.authorize,
        preconditions: { stateVector, nodes: { [translated.nodeId]: "exists" } },
        index: this.yjsIndex,
      });
    } catch (error) {
      this.reject(requestId, error);
      return true;
    }
    void result.catch((error) => this.reject(requestId, error));
    return true;
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
      this.current = this.current.apply(transaction);
      this.permitted.delete(transaction);
      this.counters.lastIndexNodesVisited = this.index.updateChanged(nodeIds, this.current.doc);
    }
    this.counters.incrementalTextTransactions++;
    this.emit({
      state: this.current,
      transaction,
      changedNodeIds: [...nodeIds],
      ...(request ? { request: { requestId: request.requestId, transactionId: request.transactionId, status: transaction ? "reconciled" : "acknowledged" } } : {}),
    });
  }

  private install(projected: PmNode, changedNodeIds: string[], transactionId?: string, direction: "nml-to-pm" | "pm-reconcile" = "nml-to-pm", request?: BridgeRequestUpdate): void {
    const before = this.current.doc;
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
      this.current = this.current.apply(transaction);
      this.permitted.delete(transaction);
      this.counters.lastIndexNodesVisited = this.index.update(this.current.doc);
    }
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
        this.installPlainText(nodeIds, request);
        return;
      }
      const next = change.document ?? decodeNmlDocument(this.doc);
      const projected = this.projection.project(next);
      this.counters.fullProjections++;
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
    this.report({ code: "commit_rejected", nodeId: request.nodeId });
    if (error instanceof NmlCommandConflict && error.code === "unauthorized") this.report({ code: "content_rejected", nodeId: request.nodeId });
    if (!this.source) return;
    try {
      const projected = this.projection.project(this.source);
      this.counters.fullProjections++;
      this.install(projected, [request.nodeId], undefined, "pm-reconcile", { requestId, status: "rejected" });
    } catch {
      this.mode = "frozen";
      this.report({ code: "projection_failed", nodeId: request.nodeId });
      this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
    }
  }

  checkDrift(candidate = this.current.doc): boolean {
    if (!this.source || this.pending.size || this.mode === "destroyed" || this.mode === "frozen") return false;
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
    this.pending.clear();
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
    super(doc, diagnostics, registry, options);
  }
}
