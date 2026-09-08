import { EditorState, Plugin, type Transaction } from "prosemirror-state";
import type { Node as PmNode } from "prosemirror-model";
import type * as Y from "yjs";
import { decodeNmlDocument, observeNmlChanges, type NmlChangeSet } from "../yjs";
import type { NmlBlock, NmlDocument } from "../schema";
import { serializeDocument } from "../serialize";
import { NmlProjection, NodeAdapterRegistry, canonicalBlocks } from "./projection";
import { PositionIndex } from "./position-index";

export type BridgeDiagnostic = { code: "invalid_source" | "unsupported_node" | "projection_drift" | "projection_failed" | "content_rejected"; nodeId?: string };
export type BridgeStatus = "ready" | "degraded" | "frozen" | "destroyed";
export type BridgeUpdate = { state: EditorState; transaction: Transaction | null; changedNodeIds: string[] };

/** An already-authorized, non-owning reader. No provider, executor, or shared-type writer. */
export class ReadOnlyNmlBridge {
  readonly projection: NmlProjection;
  readonly index = new PositionIndex();
  private current: EditorState;
  private source: NmlDocument | null = null;
  private blocks = new Map<string, NmlBlock>();
  private mode: BridgeStatus = "ready";
  private stop: () => void = () => {};
  private driftCount = 0;
  private listeners = new Set<(update: BridgeUpdate) => void>();
  private permitted = new WeakSet<Transaction>();

  constructor(private readonly doc: Y.Doc, private readonly diagnostics: (diagnostic: BridgeDiagnostic) => void = () => {}, registry = new NodeAdapterRegistry()) {
    this.projection = new NmlProjection(registry);
    let projected: PmNode;
    try {
      this.source = decodeNmlDocument(doc);
      projected = this.projection.project(this.source);
      this.blocks = canonicalBlocks(this.source);
      this.checkUnsupported(projected);
    } catch {
      this.mode = "frozen";
      this.report({ code: "invalid_source" });
      projected = this.projection.schema.nodes.doc.createChecked({ documentId: "unavailable", schemaVersion: 1 });
    }
    this.current = EditorState.create({ doc: projected, plugins: [new Plugin({
      filterTransaction: (transaction) => !transaction.docChanged || this.permitted.has(transaction),
      props: { editable: () => false },
    })] });
    this.index.update(projected);
    if (this.source) this.stop = observeNmlChanges(doc, (change) => this.receive(change));
  }
  get state(): EditorState { return this.current; }
  status(): BridgeStatus { return this.mode; }
  getBlock(id: string): NmlBlock | undefined { const block = this.blocks.get(id); return block ? structuredClone(block) : undefined; }
  snapshot(): NmlDocument | null { return this.source ? structuredClone(this.source) : null; }
  subscribe(listener: (update: BridgeUpdate) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  reportViewFailure(nodeId: string): void {
    if (this.mode === "destroyed") return;
    this.mode = "frozen";
    this.report({ code: "projection_failed", nodeId });
    this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
  }
  private report(diagnostic: BridgeDiagnostic): void {
    // Telemetry must not interrupt a canonical Yjs transaction or receive content.
    try { this.diagnostics(diagnostic); } catch { /* The reader remains fail-closed. */ }
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
  dispatch(transaction: Transaction): boolean {
    if (this.mode === "destroyed" || this.mode === "frozen") return false;
    if (transaction.docChanged) { this.report({ code: "content_rejected" }); return false; }
    if (!transaction.before.eq(this.current.doc)) return false;
    this.current = this.current.apply(transaction);
    this.emit({ state: this.current, transaction, changedNodeIds: [] });
    return true;
  }
  private install(projected: PmNode, changedNodeIds: string[], transactionId?: string): void {
    const before = this.current.doc;
    let transaction: Transaction | null = null;
    if (!before.eq(projected)) {
      transaction = this.current.tr;
      if (!before.sameMarkup(projected)) {
        // Document identity/schema cannot change beneath an open reader.
        throw new Error("Canonical document identity changed");
      }
      const start = before.content.findDiffStart(projected.content);
      if (start !== null) {
        const end = before.content.findDiffEnd(projected.content)!;
        const overlap = start - Math.min(end.a, end.b);
        if (overlap > 0) { end.a += overlap; end.b += overlap; }
        transaction.replace(start, end.a, projected.slice(start, end.b));
      }
      transaction.setMeta("nmlBridge", { direction: "nml-to-pm", canonicalTransactionId: transactionId }).setMeta("addToHistory", false);
      if (!transaction.doc.eq(projected)) throw new Error("Projection transaction mismatch");
      this.permitted.add(transaction);
      this.current = this.current.apply(transaction);
      this.permitted.delete(transaction);
      this.index.update(this.current.doc);
    }
    this.emit({ state: this.current, transaction, changedNodeIds });
  }
  private receive(change: NmlChangeSet): void {
    if (this.mode === "destroyed" || this.mode === "frozen") return;
    if (change.diagnostics.length) { this.mode = "frozen"; this.report({ code: "invalid_source" }); this.emit({ state: this.current, transaction: null, changedNodeIds: [] }); return; }
    try {
      const next = decodeNmlDocument(this.doc);
      const projected = this.projection.project(next);
      const blocks = canonicalBlocks(next);
      // The current observer is a full-AST observer and can omit simultaneous domain
      // changes on moved nodes. Compare snapshots until its later incremental upgrade.
      const changedNodeIds = [...new Set([...this.blocks.keys(), ...blocks.keys()])].filter((id) => JSON.stringify(this.blocks.get(id)) !== JSON.stringify(blocks.get(id)));
      this.source = next;
      this.blocks = blocks;
      this.mode = "ready";
      this.checkUnsupported(projected);
      this.install(projected, changedNodeIds, change.transactionId);
    } catch {
      this.mode = "frozen";
      this.report({ code: "projection_failed" });
      this.emit({ state: this.current, transaction: null, changedNodeIds: [] });
    }
  }
  /** Explicit parity check for development/idle time, never a keystroke hook. */
  checkDrift(candidate = this.current.doc): boolean {
    if (!this.source || this.mode === "destroyed" || this.mode === "frozen") return false;
    try {
      const actual = this.projection.read(candidate, this.source);
      const freshIndex = new PositionIndex();
      freshIndex.update(candidate);
      if (serializeDocument(actual) === serializeDocument(this.source) && candidate.eq(this.current.doc) && JSON.stringify([...freshIndex.byId]) === JSON.stringify([...this.index.byId])) return true;
    } catch { /* Rebuild once from canonical data, never from the suspect PM tree. */ }
    this.report({ code: "projection_drift" });
    if (++this.driftCount > 1) { this.mode = "frozen"; this.emit({ state: this.current, transaction: null, changedNodeIds: [] }); return false; }
    try { this.index.update(this.current.doc); this.install(this.projection.project(this.source), [...this.blocks.keys()]); }
    catch { this.mode = "frozen"; this.report({ code: "projection_failed" }); }
    return false;
  }
  destroy(): void { this.stop(); this.listeners.clear(); this.mode = "destroyed"; }
}
