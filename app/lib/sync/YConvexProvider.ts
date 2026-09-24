import type { ConvexReactClient } from "convex/react";
import { ConvexError } from "convex/values";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { api } from "@/convex/_generated/api";
import type { PageDigest } from "@/convex/context/shape";
import { encodePreview } from "@/convex/previewShape";
import { splitUpdate } from "@/convex/yshape";
import { COMMENTS_REFUSED } from "@/app/lib/comments/policy";
import { WRITE_REFUSED } from "@/convex/roles";
import { openYDoc } from "./ydocRead";

/**
 * A Yjs provider over Convex: the `meta` query is the wake-up channel, and
 * everything heavy moves by cursor — snapshot chunks, then the update log.
 *
 * Three facts carry the whole design. Yjs update application is idempotent
 * and commutative, so overlap is never a bug: our own appends come back
 * through the subscription and land as no-ops, a snapshot applied over state
 * we already hold merges to the same document, and nothing depends on
 * delivery order. The server's seq is dense, so "behind" is one integer
 * comparison. And origin tagging is the entire echo story: every remote byte
 * is applied with this provider as origin, so the doc listener only ever
 * queues genuinely local edits.
 *
 * One instance per open document, shared through {@link acquireProvider} —
 * refcounted rather than owned by a component, because StrictMode mounts
 * twice and two panes may open one page, and neither should mean two
 * subscriptions racing on one Y.Doc.
 */

/** Trailing throttle for shipping local edits. */
const FLUSH_MS = 500;
/** Failed flushes retry on a doubling delay, capped here. */
const MAX_RETRY_MS = 10_000;
/**
 * A merged flush larger than this is sent as its original updates instead —
 * each is keystroke-batch sized. A SINGLE update past the cap is split by
 * `yshape.splitUpdate` and sent as one multi-row append: an accepted drawn
 * storyboard is exactly that, one 2MiB+ update from one transaction.
 */
const MERGE_CAP_BYTES = 800 * 1024;
/**
 * How closely two writes of derived data — the preview and the context digest
 * — may follow each other. Both want seconds-freshness, and the read behind
 * them walks the whole document, so they share one read and one clock.
 */
const DERIVED_MS = 4000;
/** Cursor moves ride a trailing throttle; stillness still beats every 10s. */
const AWARENESS_THROTTLE_MS = 200;
const KEEPALIVE_MS = 10_000;
/** A presence row older than this is somebody gone; the caret comes down. */
const PRESENCE_STALE_MS = 30_000;

type Listener = () => void;

/** What a coded `ConvexError` carries, or null for any other failure. */
function dataOf(error: unknown): { code?: unknown; message?: unknown } | null {
  return error instanceof ConvexError ? (error.data as { code?: unknown; message?: unknown } | null) : null;
}

/** The server's reason when it refused a comments append outright, or null for any other failure. */
function refusalOf(error: unknown): string | null {
  const data = dataOf(error);
  return data?.code === COMMENTS_REFUSED && typeof data.message === "string" ? data.message : null;
}

/**
 * What a provider does beyond syncing its document. Both default on, which is
 * a page: its flushes leave a preview and a context digest behind, and its
 * awareness rides the presence table. A page's comments document turns both
 * off — it is not a page to preview or digest, and it has no carets — and the
 * server refuses it on both channels anyway.
 */
export type ProviderOptions = {
  /** Write the preview and context digest behind flushes. */
  derived?: boolean;
  /** Watch and announce presence. */
  presence?: boolean;
};

function withDefaults(options: ProviderOptions): Readonly<Required<ProviderOptions>> {
  return { derived: options.derived ?? true, presence: options.presence ?? true };
}

export class YConvexProvider {
  private currentDoc: Y.Doc;
  private currentAwareness: Awareness;
  /** One per instance — the identity of THIS tab's presence row. */
  readonly sessionId = crypto.randomUUID();

  private client: ConvexReactClient;
  private docId: string;
  readonly options: Readonly<Required<ProviderOptions>>;

  private connected = false;
  private syncedFlag = false;
  private resolveSynced!: () => void;
  private synchronizing = this.untilSynced();
  /** Why the server last refused this tab's changes outright; null once a flush lands. */
  private refused: string | null = null;
  /**
   * Whether the surface this document is open in may write it — false for a
   * reader, whose document can still change locally (the NML compatibility
   * mirror repairs its projection) but has nothing to send.
   */
  private writable = true;
  /** The server refused this tab's pen outright; nothing is sent until it is handed back. */
  private denied = false;
  /** Whether the queue holds changes made while the surface could write. */
  private owes = false;

  /** Highest seq applied locally — the fetch cursor. */
  private cursor = 0;
  private queue: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 0;
  private inflight = false;
  private pulling = false;
  private pullAgain = false;
  private unwatch: (() => void) | null = null;
  private listeners = new Set<Listener>();

  private derivedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last preview the server took; undefined until one has been offered. */
  private sentPreview: string | null | undefined;
  /** The hash of the last digest offered; undefined until one has been. */
  private sentDigest: string | undefined;

  private unwatchPresence: (() => void) | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Remote clientIds we've surfaced, and when their row was last fresh. */
  private seenClients = new Map<number, number>();
  /** Live remote sessions at the last presence push — 0 means no audience. */
  private peers = 0;
  /** Whether this session has announced itself at all since connecting. */
  private announced = false;
  private onPageHide = () => void this.sendLeave();

  constructor(
    client: ConvexReactClient,
    docId: string,
    doc: Y.Doc,
    options: ProviderOptions = {},
  ) {
    this.client = client;
    this.docId = docId;
    this.options = withDefaults(options);
    this.currentDoc = doc;
    this.currentAwareness = this.adopt(doc);
  }

  /** Listens to a doc as this provider's own, returning its awareness. */
  private adopt(doc: Y.Doc): Awareness {
    const awareness = new Awareness(doc);
    doc.on("update", this.onDocUpdate);
    awareness.on("update", this.onAwareness);
    byDoc.set(doc, this);
    return awareness;
  }

  /**
   * The synced document. Replaced only after the server refuses a change
   * outright (see `restart`), so a holder that re-reads it on `subscribe`
   * always has the live one.
   */
  get doc(): Y.Doc {
    return this.currentDoc;
  }

  get awareness(): Awareness {
    return this.currentAwareness;
  }

  get synced(): boolean {
    return this.syncedFlag;
  }

  /** Resolves once `doc` has caught up with the server. */
  get whenSynced(): Promise<void> {
    return this.synchronizing;
  }

  private untilSynced(): Promise<void> {
    return new Promise((resolve) => (this.resolveSynced = resolve));
  }

  /** Why the server last refused this tab's changes outright, until one lands or it is dismissed. */
  get refusal(): string | null {
    return this.refused;
  }

  dismissRefusal() {
    if (this.refused === null) return;
    this.refused = null;
    this.emit();
  }

  get hasUnsyncedChanges(): boolean {
    return (this.owes && this.queue.length > 0) || this.inflight;
  }

  /** Whether the server refused this tab's changes for who is sending them. */
  get writeRefused(): boolean {
    return this.denied;
  }

  /**
   * Changes written here that the server will not take from this tab now:
   * made while it could write, left unsent once it could not. They stay in
   * the document, so what they say can still be copied out.
   */
  get stranded(): boolean {
    return this.owes && this.queue.length > 0 && !this.sending;
  }

  private get sending(): boolean {
    return this.writable && !this.denied;
  }

  /**
   * Whether the surface may write, from the role it was given. Said writable —
   * the pen handed back, or a surface mounting on a document refused before —
   * whatever was held is offered once more.
   */
  setWritable(writable: boolean) {
    if (writable === this.writable && !(writable && this.denied)) return;
    this.writable = writable;
    if (writable) this.retryHeld();
    else this.emit();
  }

  /** Offers what the server refused once more: the person's own "try again". */
  retryHeld() {
    this.denied = false;
    this.emit();
    this.scheduleFlush(0);
  }

  /** Fires on any state change worth re-rendering for (synced, unsynced). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  connect() {
    if (this.connected) return;
    this.connected = true;
    // Subscribe first: a change that lands during the initial load just
    // schedules a pull that the idempotence makes safe.
    const watch = this.client.watchQuery(api.ydoc.meta, { docId: this.docId });
    this.unwatch = watch.onUpdate(this.wake);
    this.wake();
    if (!this.options.presence) return;

    const presence = this.client.watchQuery(api.presence.list, {
      docId: this.docId,
    });
    // A query that errors rethrows from `localQueryResult`. Losing the page
    // (its last link turned off under a collaborator) is such an error, and
    // the answer to it is an empty room, not an uncaught throw every tick.
    const roster = () => {
      try {
        return presence.localQueryResult() ?? [];
      } catch {
        return [];
      }
    };
    this.unwatchPresence = presence.onUpdate(() => this.applyPresence(roster()));
    this.keepaliveTimer = setInterval(() => {
      this.sendAwareness();
      // Re-judge staleness on our own clock too: if everyone left without a
      // goodbye, no list update arrives to take their carets down.
      this.applyPresence(roster());
    }, KEEPALIVE_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
    }
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.peers = 0;
    this.announced = false;
    this.unwatch?.();
    this.unwatch = null;
    this.unwatchPresence?.();
    this.unwatchPresence = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.awarenessTimer) {
      clearTimeout(this.awarenessTimer);
      this.awarenessTimer = null;
    }
    // Leaving with derived data still owed: written now, since the last edits
    // before closing a page are exactly the ones its thumbnail should show.
    if (this.derivedTimer) {
      clearTimeout(this.derivedTimer);
      this.derivedTimer = null;
      void this.writeDerived();
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    if (this.options.presence) void this.sendLeave();
    // A parting attempt at anything unsent; the queue survives failure and
    // ships on reconnect.
    if (this.queue.length) void this.flush();
  }

  destroy() {
    this.disconnect();
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwareness);
    this.awareness.destroy();
    this.listeners.clear();
  }

  // ---- Remote → doc -------------------------------------------------------

  /**
   * Bring the doc up to the server's seq. Serialized by a latch — a second
   * wake-up during a pull runs one more pull after, never two at once.
   */
  /**
   * A pull, from a watch or on connect. One that fails is a document that has
   * stopped answering this caller — the page's last link turned off under
   * them — and waits quietly for the next wake rather than surfacing as an
   * unhandled rejection on every change.
   */
  private wake = () => {
    this.pull().catch(() => {});
  };

  private async pull() {
    if (!this.connected) return;
    if (this.pulling) {
      this.pullAgain = true;
      return;
    }
    this.pulling = true;
    try {
      do {
        this.pullAgain = false;
        // Once synced, the watch holds `meta` and asking it is free — which
        // matters, because most wake-ups are our own flush echoing back and
        // end right here. The first pull skips the question: `load` answers
        // it, and waiting for `meta` first is a round trip spent learning
        // only that there is a document to fetch.
        if (this.syncedFlag) {
          const meta = await this.client.query(api.ydoc.meta, {
            docId: this.docId,
          });
          if (!meta || this.cursor >= meta.seq) continue;
        }
        const doc = this.doc;
        const opened = await openYDoc(
          this.client,
          this.docId,
          this.cursor,
          (update) => Y.applyUpdate(doc, update, this),
        );
        // Restarted meanwhile: that cursor belonged to the doc it replaced.
        if (doc !== this.doc) {
          this.pullAgain = true;
          continue;
        }
        if (!opened) continue; // not Yjs-native (yet); the watch will say when
        this.cursor = opened.cursor;
        if (opened.torn) {
          this.pullAgain = true;
          continue;
        }
        if (!this.syncedFlag && this.cursor >= opened.seq) {
          this.syncedFlag = true;
          this.resolveSynced();
          this.emit();
          // A page opened is a page whose node can be brought up to date, so a
          // page written before the graph existed joins it on its next visit.
          // Only the digest: an unchanged thumbnail is not worth a write.
          void this.writeDerived({ preview: false });
        }
      } while (this.pullAgain);
    } finally {
      this.pulling = false;
    }
  }

  // ---- Awareness ↔ presence ----------------------------------------------

  /**
   * Local awareness changes (caret moves, selection, the user field BlockNote
   * sets) ship as one small heartbeat on a trailing throttle; a keepalive
   * refreshes the row while nothing moves. Anything applied with "remote" as
   * origin is someone else's state coming back and never re-ships.
   *
   * Alone, only the announcement goes out: a caret with no audience is not
   * worth a write per keystroke, the keepalive keeps the row alive, and
   * `applyPresence` sends the moment somebody arrives to see it.
   */
  private onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === "remote" || !this.connected || !this.options.presence) return;
    const mine = this.doc.clientID;
    if (![...added, ...updated, ...removed].includes(mine)) return;
    if (this.announced && this.peers === 0) return;
    if (this.awarenessTimer) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.sendAwareness();
    }, AWARENESS_THROTTLE_MS);
  };

  private sendAwareness() {
    if (!this.connected || !this.options.presence) return;
    const local = this.awareness.getLocalState();
    if (!local) return;
    const user = (local.user ?? {}) as {
      name?: string;
      color?: string;
      imageUrl?: string;
    };
    const encoded = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    this.announced = true;
    void this.client
      .mutation(api.presence.heartbeat, {
        docId: this.docId,
        sessionId: this.sessionId,
        clientId: this.doc.clientID,
        user: {
          name: user.name ?? "Someone",
          color: user.color ?? "#888888",
          ...(user.imageUrl ? { imageUrl: user.imageUrl } : {}),
        },
        state: encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength,
        ) as ArrayBuffer,
      })
      .catch(() => {
        // Presence is best-effort by definition; the keepalive retries.
      });
  }

  private applyPresence(
    rows: Array<{
      sessionId: string;
      clientId: number;
      state: ArrayBuffer;
      updatedAt: number;
    }>,
  ) {
    const now = Date.now();
    const live = new Set<number>();
    for (const row of rows) {
      if (row.sessionId === this.sessionId) continue;
      if (now - row.updatedAt > PRESENCE_STALE_MS) continue;
      live.add(row.clientId);
      // A row nobody rewrote holds the state we already applied; decoding it
      // again is work y-protocols would only discard after the fact.
      if (this.seenClients.get(row.clientId) === row.updatedAt) continue;
      this.seenClients.set(row.clientId, row.updatedAt);
      // A client we are not showing has no clock worth defending. y-protocols
      // keeps a removed client's clock and applies only a HIGHER one, so the
      // heartbeat that brings someone back — the same state at the same clock,
      // because nothing about them changed while they were away — is rejected,
      // and they stay off the carets and the canvas until their own renewal
      // timer outruns it. Their live row is the truth, whatever clock it says.
      if (!this.awareness.states.has(row.clientId)) {
        this.awareness.meta.delete(row.clientId);
      }
      applyAwarenessUpdate(this.awareness, new Uint8Array(row.state), "remote");
    }
    const gone = [...this.seenClients.keys()].filter((id) => !live.has(id));
    if (gone.length) {
      for (const id of gone) this.seenClients.delete(id);
      removeAwarenessStates(this.awareness, gone, "remote");
    }
    // Arriving into an empty room means nothing was being sent; the first
    // person to join has to be told where the caret is.
    const alone = this.peers === 0;
    this.peers = live.size;
    if (alone && this.peers > 0) this.sendAwareness();
  }

  private async sendLeave() {
    await this.client
      .mutation(api.presence.leave, {
        docId: this.docId,
        sessionId: this.sessionId,
      })
      .catch(() => {});
  }

  // ---- Doc → remote -------------------------------------------------------

  /** When the last flush left, for the leading edge below. */
  private lastFlushAt = 0;

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    this.queue.push(update);
    if (this.writable) this.owes = true;
    this.emit();
    // Held, not sent: kept as one update, so a reader's tab left open all day
    // does not accumulate every repair its mirror ever made.
    if (!this.sending) {
      if (this.queue.length > 1) this.queue = [Y.mergeUpdates(this.queue)];
      return;
    }
    // Leading edge: the first edit after quiet ships as soon as the current
    // task ends, so a collaborator sees a gesture land the moment it ends; a
    // burst still batches on the trailing throttle. A microtask rather than
    // an immediate call, so everything one task writes — an accept AND the
    // flash marker that must arrive with it — travels as one flush.
    if (
      !this.inflight &&
      !this.flushTimer &&
      Date.now() - this.lastFlushAt > FLUSH_MS
    ) {
      queueMicrotask(() => void this.flush());
      return;
    }
    this.scheduleFlush(FLUSH_MS);
  };

  private scheduleFlush(afterMs: number) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, afterMs);
  }

  private async flush() {
    if (this.inflight || this.queue.length === 0 || !this.sending) return;
    const taken = this.queue;
    this.queue = [];
    const merged = Y.mergeUpdates(taken);
    const batch =
      merged.byteLength <= MERGE_CAP_BYTES ? [merged] : taken;
    this.inflight = true;
    this.emit();
    try {
      for (const update of batch) {
        // Split when one row cannot hold it — a drawn storyboard's accept is
        // one transaction and therefore one update, measured past 2MiB. One
        // mutation carries every part, so the group lands atomically.
        const chunks = splitUpdate(update);
        const seq = await this.client.mutation(
          api.ydoc.append,
          chunks.length === 1
            ? { docId: this.docId, update: chunks[0] }
            : { docId: this.docId, chunks },
        );
        // Landing exactly one past the cursor proves nobody else's update sits
        // in the gap — the seq is dense — so these bytes, which the doc
        // already holds, need not be downloaded back to be skipped.
        if (seq === this.cursor + 1) this.cursor = seq;
      }
      this.retryMs = 0;
      this.refused = null;
      if (this.queue.length === 0) this.owes = false;
      this.lastFlushAt = Date.now();
      this.scheduleDerived();
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal !== null) {
        this.restart(refusal);
        return;
      }
      // The pen was taken — a link run out while its query still showed it
      // live. Retrying cannot land this and restarting would throw away what
      // was written, so it is held, and the surface says so.
      if (dataOf(error)?.code === WRITE_REFUSED) {
        this.queue = [merged, ...this.queue];
        this.denied = true;
        this.retryMs = 0;
        return;
      }
      // Everything unsent goes back to the front, coalesced, and retries on
      // a doubling delay — the queue is the offline buffer.
      this.queue = [merged, ...this.queue];
      this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs ? this.retryMs * 2 : 1000);
      this.scheduleFlush(this.retryMs);
    } finally {
      this.inflight = false;
      this.emit();
      if (this.queue.length && !this.flushTimer && this.retryMs === 0 && this.sending) {
        this.scheduleFlush(FLUSH_MS);
      }
    }
  }

  /**
   * The server refused a flush for what it says, not for who or when — a
   * comments write its policy will never take (`comments/policy.ts`). A retry
   * cannot land it, and this doc now holds changes the server will never
   * have: every later edit here would build on them and be refused in turn.
   * So the doc is swapped for a fresh one synced from the server, which
   * leaves this tab exactly where everyone else is, and the refusal is kept
   * for the surface to say why its change went.
   */
  private restart(refusal: string) {
    const old = this.currentDoc;
    old.off("update", this.onDocUpdate);
    this.currentAwareness.off("update", this.onAwareness);
    this.currentAwareness.destroy();
    byDoc.delete(old);
    this.queue = [];
    this.owes = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.retryMs = 0;
    this.cursor = 0;
    this.syncedFlag = false;
    this.synchronizing = this.untilSynced();
    this.refused = refusal;
    this.currentDoc = new Y.Doc();
    this.currentAwareness = this.adopt(this.currentDoc);
    this.emit();
    this.wake();
  }

  // ---- Derived data -------------------------------------------------------

  /**
   * The document's stored preview (`schema.pagePreviews`) and its node in the
   * context graph (`context/pages.digest`) are kept here, behind the flush,
   * because this is the one seam every Yjs writer passes through — an open
   * editor, the agent editing a page nobody has open, a second pane. Only
   * local edits flush, so of all the tabs on a page it is the one that made a
   * change that writes what is derived from it.
   */
  private scheduleDerived() {
    if (this.derivedTimer || !this.options.derived) return;
    this.derivedTimer = setTimeout(() => {
      this.derivedTimer = null;
      void this.writeDerived();
    }, DERIVED_MS);
  }

  private async writeDerived({ preview = true } = {}) {
    if (!this.options.derived) return;
    // BlockNote's schema is what reads a Y.Doc as blocks; imported here so
    // a surface that only syncs never pays for it.
    try {
      const [{ blocksFromYDoc }, { digestPage }] = await Promise.all([
        import("@/app/lib/ai/snapshot"),
        import("@/app/lib/ai/context/digest"),
      ]);
      const blocks = blocksFromYDoc(this.doc);
      await Promise.all([
        preview ? this.writePreview(encodePreview(blocks)) : null,
        this.writeDigest(digestPage(blocks)),
      ]);
    } catch {
      // Derived data: the next flush offers it again.
    }
  }

  private async writePreview(blocks: string | null) {
    // Most edits land below the fold of a thumbnail and change nothing.
    if (blocks === this.sentPreview) return;
    try {
      await this.client.mutation(api.previews.set, {
        docId: this.docId,
        blocks,
        seq: this.cursor,
      });
      this.sentPreview = blocks;
    } catch {
      // Derived data: the next flush offers it again.
    }
  }

  private async writeDigest(digest: PageDigest) {
    if (digest.contentHash === this.sentDigest) return;
    try {
      // Declined while an AI turn on the page awaits review; not remembered
      // as sent, so the next flush or visit offers it again.
      const taken = await this.client.mutation(api.context.pages.digest, {
        docId: this.docId,
        digest,
      });
      if (taken) this.sentDigest = digest.contentHash;
    } catch {
      // Derived data: the next flush offers it again.
    }
  }
}

// ---- Shared instances -----------------------------------------------------

type Held = { provider: YConvexProvider; refs: number };
const held = new Map<string, Held>();

/**
 * Documents let go of recently, kept in memory rather than destroyed. The
 * expensive part of opening a page is the snapshot and the log behind it, and
 * a back-navigation is the one case where we already have both — reviving one
 * of these paints from a doc that is already synced, while `connect` catches
 * up whatever changed in between. Presence is dropped on release, so a warm
 * doc costs nothing on the wire.
 */
const RECENT_MAX = 4;
const recent = new Map<string, YConvexProvider>();
/** Whose session the warm docs belong to; a different client discards them. */
let recentClient: ConvexReactClient | null = null;

function forget(docId: string, provider: YConvexProvider) {
  recent.delete(docId);
  provider.destroy();
  provider.doc.destroy();
}

/**
 * Provider by Y.Doc — how surfaces that hold a doc but not a docId (the
 * canvas binding) reach the awareness channel. A forked doc has no provider,
 * which is exactly right: a fork is private, and presence must not leak it.
 */
const byDoc = new WeakMap<Y.Doc, YConvexProvider>();

export function providerForDoc(doc: Y.Doc): YConvexProvider | null {
  return byDoc.get(doc) ?? null;
}

/**
 * One provider (and one Y.Doc) per docId, however many components mount it.
 * Release schedules teardown on a microtask-later tick so StrictMode's
 * unmount/remount pair lands on the same live instance.
 */
export function acquireProvider(
  client: ConvexReactClient,
  docId: string,
  options: ProviderOptions = {},
): YConvexProvider {
  if (recentClient !== client) {
    for (const [id, provider] of recent) forget(id, provider);
    recentClient = client;
  }
  // A docId is one kind of document for life, so a second opinion about what
  // its provider does is a caller bug — not something to settle by first come.
  const existing = held.get(docId)?.provider ?? recent.get(docId);
  const wanted = withDefaults(options);
  if (existing && (existing.options.derived !== wanted.derived || existing.options.presence !== wanted.presence)) {
    throw new Error(`Provider for ${docId} is already held with different options.`);
  }
  let entry = held.get(docId);
  if (!entry) {
    const warm = recent.get(docId);
    recent.delete(docId);
    entry = {
      provider: warm ?? new YConvexProvider(client, docId, new Y.Doc(), options),
      refs: 0,
    };
    held.set(docId, entry);
  }
  entry.refs++;
  entry.provider.connect();
  return entry.provider;
}

/** The live instance for a doc, if one is held — no refcount taken. */
export function peekProvider(docId: string): YConvexProvider | null {
  return held.get(docId)?.provider ?? null;
}

export function releaseProvider(docId: string) {
  const entry = held.get(docId);
  if (!entry) return;
  entry.refs--;
  setTimeout(() => {
    if (entry.refs > 0 || held.get(docId) !== entry) return;
    held.delete(docId);
    entry.provider.disconnect();
    recent.set(docId, entry.provider);
    for (const [oldest, provider] of recent) {
      if (recent.size <= RECENT_MAX) break;
      forget(oldest, provider);
    }
  }, 0);
}
