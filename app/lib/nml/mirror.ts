import * as Y from "yjs";
import type { LegacyBlock } from "./legacy";
import { convertLegacyDocument } from "./legacy";
import type { NmlBlock, NmlDocument, NmlInlineContent } from "./schema";
import { executeNmlCommands } from "./commands";
import { decodeNmlDocument, NML_YJS_ROOT, type NmlTransactionOrigin } from "./yjs";
import { nmlToAnyBlocks } from "./model/projection";
import { compileProjectionChange } from "./view/translation";
import {
  canvasBlocks,
  canvasFromMapsCommands,
  changedCanvasIds,
  mapsHoldCanvas,
  withCanvasData,
} from "./canvasMaps";

/** Transaction origin used only for the derived NML → legacy projection. */
export const NML_LEGACY_MIRROR_ORIGIN = Symbol("nml-legacy-mirror");

/**
 * The mirror owns policy and convergence; the browser adapter owns BlockNote's
 * Y.XmlFragment conversion. Keeping that seam small makes the mixed-client
 * contract testable without a DOM or an editor instance.
 */
export type NmlLegacyMirrorHost = {
  readBlocks(): LegacyBlock[];
  writeBlocks(blocks: LegacyBlock[], origin: typeof NML_LEGACY_MIRROR_ORIGIN): void;
  subscribe(listener: (origin: unknown) => void): () => void;
  /** Each diagram block's `data` prop as the legacy root holds it now. */
  readCanvasData?(): Map<string, string>;
};

export type NmlLegacyMirrorOptions = {
  actor: NmlTransactionOrigin["actor"];
  /** Captured synchronously with a legacy transaction (for AI attribution). */
  actorForChange?: () => NmlTransactionOrigin["actor"];
  createId?: () => string;
  createRequestId?: () => string;
  authorize?: () => boolean | Promise<boolean>;
  resolveStorageUrl?: (storageId: string) => Promise<string | null | undefined>;
  onError?: (error: unknown) => void;
  /** An edit canonical NML would not take was undone in the editor. */
  onReverted?: () => void;
  /**
   * Whether a transaction arrived from a collaborator, whose own client carried
   * its diagram changes into NML in the same flush. Defaults to any applied
   * update; the browser narrows it to its provider, so a review's kept changes,
   * merged in as an update, still count as this client's.
   */
  isRemote?: (transaction: Y.Transaction) => boolean;
};

type PendingLegacyProjection = {
  actor: NmlTransactionOrigin["actor"];
  before: NmlDocument;
  blocks: LegacyBlock[];
};

let mirrorInstanceSequence = 0;

function atomKey(node: NmlInlineContent[number]): string {
  return node.type === "math"
    ? `math:${node.latex}`
    : node.type === "pageRef"
      ? `page:${node.pageId}:${node.fallbackTitle}`
      : node.type === "checkbox"
        ? `check:${node.checked}`
        : "";
}

/** Inline entities carrying an NML-only stable ID that BlockNote has no field for. */
type InlineEntity = Extract<NmlInlineContent[number], { id: string }>;
function isInlineEntity(node: NmlInlineContent[number]): node is InlineEntity {
  return node.type === "math" || node.type === "pageRef" || node.type === "checkbox";
}

/**
 * BlockNote has no field for NML-only sub-entity IDs. Reattach those IDs to a
 * converted legacy snapshot before diffing it into canonical NML. Exact-value
 * matches win (so inserting before an entity does not rename it), then the
 * remaining entities pair by order for ordinary in-place edits.
 */
function preserveInlineIds(before: NmlInlineContent, after: NmlInlineContent): void {
  const prior = before.filter(isInlineEntity);
  const next = after.filter(isInlineEntity);
  const used = new Set<number>();
  next.forEach((node, index) => {
    if (!isInlineEntity(node)) return;
    let found = prior.findIndex((candidate, candidateIndex) =>
      !used.has(candidateIndex) && candidate.type === node.type && atomKey(candidate) === atomKey(node));
    if (found < 0) found = prior.findIndex((candidate, candidateIndex) =>
      !used.has(candidateIndex) && candidate.type === node.type && candidateIndex === index);
    if (found < 0) found = prior.findIndex((candidate, candidateIndex) =>
      !used.has(candidateIndex) && candidate.type === node.type);
    if (found < 0) return;
    used.add(found);
    node.id = (prior[found] as typeof node).id;
  });
}

function rowText(row: { cells: Array<{ content: NmlInlineContent }> }): string {
  return JSON.stringify(row.cells.map((cell) => cell.content));
}

function pairByValue<T>(before: T[], after: T[], key: (value: T) => string): Array<T | undefined> {
  const result: Array<T | undefined> = Array(after.length);
  const used = new Set<number>();
  after.forEach((value, index) => {
    const found = before.findIndex((candidate, candidateIndex) =>
      !used.has(candidateIndex) && key(candidate) === key(value));
    if (found >= 0) {
      result[index] = before[found];
      used.add(found);
    }
  });
  after.forEach((_value, index) => {
    if (result[index]) return;
    const found = before.findIndex((_candidate, candidateIndex) => !used.has(candidateIndex));
    if (found >= 0) {
      result[index] = before[found];
      used.add(found);
    }
  });
  return result;
}

function preserveBlockIds(
  before: NmlBlock,
  after: NmlBlock,
  resolveStorageUrl?: (storageId: string) => string | undefined,
): void {
  if ("content" in before && "content" in after) preserveInlineIds(before.content, after.content);
  if (before.type === "table" && after.type === "table") {
    after.columns.forEach((column, index) => {
      if (before.columns[index]) column.id = before.columns[index].id;
    });
    const pairedRows = pairByValue(before.rows, after.rows, rowText);
    after.rows.forEach((row, rowIndex) => {
      const prior = pairedRows[rowIndex];
      if (!prior) return;
      row.id = prior.id;
      row.cells.forEach((cell, cellIndex) => {
        const priorCell = prior.cells[cellIndex];
        if (!priorCell) return;
        cell.id = priorCell.id;
        preserveInlineIds(priorCell.content, cell.content);
      });
    });
  }
  if (before.type === "mathBlock" && after.type === "mathBlock") {
    const pairedRows = pairByValue(before.rows, after.rows, (row) => row.latex);
    after.rows.forEach((row, index) => {
      if (pairedRows[index]) row.id = pairedRows[index]!.id;
    });
  }
  if (
    (before.type === "image" || before.type === "video" || before.type === "audio" || before.type === "file") &&
    before.type === after.type &&
    before.props.source?.kind === "storage" &&
    (!after.props.source || (after.props.source.kind === "url" &&
      (!after.props.source.url || after.props.source.url === resolveStorageUrl?.(before.props.source.storageId))))
  ) after.props.source = structuredClone(before.props.source);

  const priorChildren = new Map(before.children.map((child) => [child.id, child]));
  after.children.forEach((child) => {
    const prior = priorChildren.get(child.id);
    if (prior) preserveBlockIds(prior, child, resolveStorageUrl);
  });
}

export function preserveLegacyOnlyIdentities(
  before: NmlDocument,
  after: NmlDocument,
  resolveStorageUrl?: (storageId: string) => string | undefined,
): NmlDocument {
  const prior = new Map<string, NmlBlock>();
  const visit = (blocks: NmlBlock[]) => blocks.forEach((block) => {
    prior.set(block.id, block);
    visit(block.children);
  });
  visit(before.blocks);
  const reconcile = (blocks: NmlBlock[]) => blocks.forEach((block) => {
    const match = prior.get(block.id);
    if (match) preserveBlockIds(match, block, resolveStorageUrl);
    reconcile(block.children);
  });
  reconcile(after.blocks);
  return after;
}

export class NmlLegacyMirror {
  private stopHost: (() => void) | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingLegacyProjection: PendingLegacyProjection | null = null;
  private legacyDrainScheduled = false;
  private readonly fallbackRequestPrefix: string;
  private request = 0;
  private storageUrls = new Map<string, string>();
  private storageJobs = new Map<string, Promise<void>>();
  /** Diagrams whose maps changed here, waiting to be carried into NML, and by whom. */
  private pendingCanvas = new Map<string, NmlTransactionOrigin["actor"]>();
  private readonly onAfterTransaction = (transaction: Y.Transaction) => {
    if (this.stopped) return;
    const remote = this.options.isRemote?.(transaction) ?? !transaction.local;
    if (!remote) {
      const ids = changedCanvasIds(this.doc, transaction);
      if (ids.length) {
        const actor = this.options.actorForChange?.() ?? this.options.actor;
        ids.forEach((id) => this.pendingCanvas.set(id, actor));
        this.scheduleLegacyDrain();
      }
    }
    const root = this.doc.getMap(NML_YJS_ROOT);
    if (![...transaction.changedParentTypes.keys()].some((type) => (type as unknown) === root)) return;
    this.writeLegacyProjection();
  };

  constructor(
    private readonly doc: Y.Doc,
    private readonly host: NmlLegacyMirrorHost,
    private readonly options: NmlLegacyMirrorOptions,
  ) {
    // In the constructor, not a field initializer: under define-semantics class
    // fields (the server bundle's target) initializers run before parameter
    // properties are assigned, and `this.doc` would still be undefined.
    this.fallbackRequestPrefix = `${doc.clientID}-${++mirrorInstanceSequence}`;
  }

  start(): this {
    if (this.stopHost) return this;
    // Canonical NML always wins initialization. The legacy root may be the
    // migration snapshot and is never allowed to race the first projection.
    this.writeLegacyProjection();
    // Except for a diagram: its maps are what the person sees, and a page
    // edited before NT-129 left its NML scene behind them.
    try {
      for (const id of canvasBlocks(decodeNmlDocument(this.doc)).keys()) this.pendingCanvas.set(id, this.options.actor);
      if (this.pendingCanvas.size) this.scheduleLegacyDrain();
    } catch (error) {
      this.options.onError?.(error);
    }
    this.stopHost = this.host.subscribe((origin) => {
      if (this.stopped || origin === NML_LEGACY_MIRROR_ORIGIN) return;
      this.enqueueLegacyProjection(this.options.actorForChange?.() ?? this.options.actor);
    });
    this.doc.on("afterTransaction", this.onAfterTransaction);
    return this;
  }

  stop(): void {
    this.stopped = true;
    this.stopHost?.();
    this.stopHost = null;
    this.doc.off("afterTransaction", this.onAfterTransaction);
  }

  private writeLegacyProjection(): void {
    const document = decodeNmlDocument(this.doc);
    let held: Map<string, string> | undefined;
    const blocks = withCanvasData(nmlToAnyBlocks(document, {
      resolveStorageUrl: (storageId) => this.storageUrls.get(storageId),
    }) as LegacyBlock[], (id) => {
      if (!mapsHoldCanvas(this.doc, id)) return undefined;
      held ??= this.host.readCanvasData?.() ?? new Map();
      return held.get(id);
    });
    this.host.writeBlocks(blocks, NML_LEGACY_MIRROR_ORIGIN);
    const visit = (items: NmlBlock[]) => items.forEach((block) => {
      if (
        (block.type === "image" || block.type === "video" || block.type === "audio" || block.type === "file") &&
        block.props.source?.kind === "storage"
      ) this.resolveStorage(block.props.source.storageId);
      visit(block.children);
    });
    visit(document.blocks);
  }

  private resolveStorage(storageId: string): void {
    if (!this.options.resolveStorageUrl || this.storageUrls.has(storageId) || this.storageJobs.has(storageId)) return;
    const job = this.options.resolveStorageUrl(storageId).then((url) => {
      if (url) this.storageUrls.set(storageId, url);
      if (!this.stopped && url) this.writeLegacyProjection();
    }).catch((error) => {
      this.options.onError?.(error);
    }).finally(() => {
      this.storageJobs.delete(storageId);
    });
    this.storageJobs.set(storageId, job);
  }

  private enqueueLegacyProjection(actor: NmlTransactionOrigin["actor"]): void {
    try {
      this.pendingLegacyProjection = {
        actor,
        before: decodeNmlDocument(this.doc),
        blocks: structuredClone(this.host.readBlocks()),
      };
      this.scheduleLegacyDrain();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private scheduleLegacyDrain(): void {
    if (this.legacyDrainScheduled) return;
    this.legacyDrainScheduled = true;
    const run = async () => {
      try {
        await this.drainLegacyProjections();
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.legacyDrainScheduled = false;
        if (this.pendingLegacyProjection || this.pendingCanvas.size) this.scheduleLegacyDrain();
      }
    };
    this.queue = this.queue.then(run, run);
  }

  private async drainLegacyProjections(): Promise<void> {
    while (this.pendingLegacyProjection || this.pendingCanvas.size) {
      if (!this.pendingLegacyProjection) {
        await this.drainCanvas();
        continue;
      }
      let allowed: boolean;
      try {
        const authorization = this.options.authorize?.() ?? true;
        allowed = typeof authorization === "object" && authorization !== null && "then" in authorization
          ? await authorization
          : authorization;
      } catch (error) {
        this.pendingLegacyProjection = null;
        this.options.onError?.(error);
        continue;
      }

      // Authorization may be asynchronous. Select the newest complete legacy
      // snapshot only after it resolves, then compile and execute without
      // another asynchronous authorization gap. Every event observed while a
      // write is waiting therefore replaces its stale intermediate snapshot.
      const pending = this.pendingLegacyProjection;
      this.pendingLegacyProjection = null;
      try {
        await this.applyLegacyProjection(pending, allowed);
      } catch (error) {
        this.options.onError?.(error);
        this.retryOrRevert(pending.actor, allowed);
      }
    }
  }

  /**
   * Carries each changed diagram's maps into its NML scene. Compiled from the
   * two states as they stand when it runs, not from the transaction that asked:
   * a burst of gestures lands as one batch, and running again is a no-op.
   */
  private async drainCanvas(): Promise<void> {
    const pending = [...this.pendingCanvas];
    this.pendingCanvas.clear();
    if (this.stopped) return;
    let allowed: boolean;
    try {
      allowed = await (this.options.authorize?.() ?? true);
    } catch (error) {
      this.options.onError?.(error);
      return;
    }
    const document = decodeNmlDocument(this.doc);
    const blocks = canvasBlocks(document);
    for (const [id, actor] of pending) {
      const block = blocks.get(id);
      if (!block) continue;
      try {
        const commands = canvasFromMapsCommands(this.doc, block);
        if (!commands.length) continue;
        const requestId = this.options.createRequestId?.() ??
          `canvas-mirror-${this.fallbackRequestPrefix}-${++this.request}`;
        await executeNmlCommands({
          doc: this.doc,
          documentId: document.documentId,
          commands,
          idempotencyKey: requestId,
          origin: {
            version: 1,
            transactionId: requestId,
            actor,
            command: "canvas-mirror",
            requestId,
          },
          authorize: () => allowed,
        });
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  /**
   * A snapshot may have failed only because it was compiled against a stale
   * NML state, so it is retried once against the current one. An edit that still
   * fails is one canonical NML cannot take; left in the editor it would fail
   * every later snapshot too, wedging the page until the next projection
   * erased everything written since. Putting canonical NML back loses only
   * that edit, and the person is told.
   */
  private retryOrRevert(actor: NmlTransactionOrigin["actor"], allowed: boolean): void {
    if (this.stopped || this.pendingLegacyProjection) return;
    try {
      const retry = {
        actor,
        before: decodeNmlDocument(this.doc),
        blocks: structuredClone(this.host.readBlocks()),
      };
      this.queue = this.queue.then(() => this.applyLegacyProjection(retry, allowed)).catch((error) => {
        this.options.onError?.(error);
        this.revert();
      });
    } catch (error) {
      this.options.onError?.(error);
      this.revert();
    }
  }

  private revert(): void {
    if (this.stopped) return;
    try {
      this.writeLegacyProjection();
      this.options.onReverted?.();
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private async applyLegacyProjection(
    { actor, before, blocks }: PendingLegacyProjection,
    allowed: boolean,
  ): Promise<void> {
    const converted = convertLegacyDocument(
      { documentId: before.documentId, blocks },
      this.options.createId ? { createId: this.options.createId } : {},
    );
    const fatal = converted.diagnostics.find((issue) => issue.severity === "error");
    if (fatal) throw new Error(`Legacy mirror conversion failed: ${fatal.message}`);
    const desired = preserveLegacyOnlyIdentities(
      before,
      converted.document,
      (storageId) => this.storageUrls.get(storageId),
    );
    const translation = compileProjectionChange(before, desired);
    if (!translation.commands.length) return;
    const requestId = this.options.createRequestId?.() ??
      `legacy-mirror-${this.fallbackRequestPrefix}-${++this.request}`;
    await executeNmlCommands({
      doc: this.doc,
      documentId: before.documentId,
      commands: translation.commands,
      temporaryIds: translation.temporaryIds,
      idempotencyKey: requestId,
      createId: this.options.createId ? () => this.options.createId!() : undefined,
      origin: {
        version: 1,
        transactionId: requestId,
        actor,
        command: "legacy-mirror",
        requestId,
      },
      // The possibly-asynchronous check already completed immediately before
      // compilation. Keeping this callback synchronous makes the compile and
      // apply phases one event-loop turn.
      authorize: () => allowed,
    });
    // A diagram put back on the page (an undone delete) arrives with the scene
    // its prop held, and its maps may be further on.
    for (const id of translation.changedNodeIds) {
      if (mapsHoldCanvas(this.doc, id)) this.pendingCanvas.set(id, actor);
    }
  }

  /** Resolves after every legacy edit observed before this call has landed. */
  async settle(): Promise<void> {
    while (true) {
      const pending = this.queue;
      await pending;
      const storage = [...this.storageJobs.values()];
      await Promise.all(storage);
      if (pending === this.queue && storage.length === this.storageJobs.size) return;
    }
  }
}
