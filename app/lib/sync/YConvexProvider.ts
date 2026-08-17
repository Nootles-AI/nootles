import type { ConvexReactClient } from "convex/react";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { api } from "@/convex/_generated/api";

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
 * each is keystroke-batch sized. A SINGLE update past Convex's 1MiB value cap
 * still fails; if a surface ever legitimately produces one, the append
 * protocol grows a part/of envelope (the seam is here).
 */
const MERGE_CAP_BYTES = 800 * 1024;
/** Cursor moves ride a trailing throttle; stillness still beats every 10s. */
const AWARENESS_THROTTLE_MS = 200;
const KEEPALIVE_MS = 10_000;
/** A presence row older than this is somebody gone; the caret comes down. */
const PRESENCE_STALE_MS = 30_000;

type Listener = () => void;

export class YConvexProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** One per instance — the identity of THIS tab's presence row. */
  readonly sessionId = crypto.randomUUID();

  private client: ConvexReactClient;
  private docId: string;

  private connected = false;
  private syncedFlag = false;
  private resolveSynced!: () => void;
  readonly whenSynced: Promise<void>;

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

  private unwatchPresence: (() => void) | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Remote clientIds we've surfaced, and when their row was last fresh. */
  private seenClients = new Map<number, number>();
  private onPageHide = () => void this.sendLeave();

  constructor(client: ConvexReactClient, docId: string, doc: Y.Doc) {
    this.client = client;
    this.docId = docId;
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.whenSynced = new Promise((r) => (this.resolveSynced = r));
    doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwareness);
    byDoc.set(doc, this);
  }

  get synced(): boolean {
    return this.syncedFlag;
  }

  get hasUnsyncedChanges(): boolean {
    return this.queue.length > 0 || this.inflight;
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
    this.unwatch = watch.onUpdate(() => void this.pull());
    void this.pull();

    const presence = this.client.watchQuery(api.presence.list, {
      docId: this.docId,
    });
    this.unwatchPresence = presence.onUpdate(() =>
      this.applyPresence(presence.localQueryResult() ?? []),
    );
    this.keepaliveTimer = setInterval(() => {
      this.sendAwareness();
      // Re-judge staleness on our own clock too: if everyone left without a
      // goodbye, no list update arrives to take their carets down.
      this.applyPresence(presence.localQueryResult() ?? []);
    }, KEEPALIVE_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide);
    }
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
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
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    void this.sendLeave();
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
   * Bring the doc up to the server's seq: snapshot chunks if our log window
   * was compacted away, then the update tail. Serialized by a latch — a
   * second wake-up during a pull runs one more pull after, never two at once.
   */
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
        const meta = await this.client.query(api.ydoc.meta, {
          docId: this.docId,
        });
        if (!meta) continue; // not Yjs-native (yet); the watch will say when
        if (meta.snapshotSeq > this.cursor && meta.snapshotParts > 0) {
          for (let part = 0; part < meta.snapshotParts; part++) {
            const chunk = await this.client.query(api.ydoc.snapshot, {
              docId: this.docId,
              gen: meta.snapshotSeq,
              part,
            });
            // A chunk can vanish if a newer fold replaced it mid-read; the
            // loop re-runs from fresh meta and the partial apply was harmless.
            if (chunk === null) {
              this.pullAgain = true;
              break;
            }
            Y.applyUpdate(this.doc, new Uint8Array(chunk), this);
          }
          if (this.pullAgain) continue;
          this.cursor = meta.snapshotSeq;
        }
        while (this.cursor < meta.seq) {
          const rows = await this.client.query(api.ydoc.updatesSince, {
            docId: this.docId,
            afterSeq: this.cursor,
          });
          if (rows.length === 0) break;
          for (const row of rows) {
            Y.applyUpdate(this.doc, new Uint8Array(row.update), this);
            this.cursor = Math.max(this.cursor, row.seq);
          }
        }
        if (!this.syncedFlag && this.cursor >= meta.seq) {
          this.syncedFlag = true;
          this.resolveSynced();
          this.emit();
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
   */
  private onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === "remote" || !this.connected) return;
    const mine = this.doc.clientID;
    if (![...added, ...updated, ...removed].includes(mine)) return;
    if (this.awarenessTimer) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      this.sendAwareness();
    }, AWARENESS_THROTTLE_MS);
  };

  private sendAwareness() {
    if (!this.connected) return;
    const local = this.awareness.getLocalState();
    if (!local) return;
    const user = (local.user ?? {}) as {
      name?: string;
      color?: string;
      imageUrl?: string;
    };
    const encoded = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
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
      this.seenClients.set(row.clientId, row.updatedAt);
      applyAwarenessUpdate(this.awareness, new Uint8Array(row.state), "remote");
    }
    const gone = [...this.seenClients.keys()].filter((id) => !live.has(id));
    if (gone.length) {
      for (const id of gone) this.seenClients.delete(id);
      removeAwarenessStates(this.awareness, gone, "remote");
    }
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
    this.emit();
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
    if (this.inflight || this.queue.length === 0) return;
    const taken = this.queue;
    this.queue = [];
    const merged = Y.mergeUpdates(taken);
    const batch =
      merged.byteLength <= MERGE_CAP_BYTES ? [merged] : taken;
    this.inflight = true;
    this.emit();
    try {
      for (const update of batch) {
        await this.client.mutation(api.ydoc.append, {
          docId: this.docId,
          update: update.buffer.slice(
            update.byteOffset,
            update.byteOffset + update.byteLength,
          ) as ArrayBuffer,
        });
      }
      this.retryMs = 0;
      this.lastFlushAt = Date.now();
    } catch {
      // Everything unsent goes back to the front, coalesced, and retries on
      // a doubling delay — the queue is the offline buffer.
      this.queue = [merged, ...this.queue];
      this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs ? this.retryMs * 2 : 1000);
      this.scheduleFlush(this.retryMs);
    } finally {
      this.inflight = false;
      this.emit();
      if (this.queue.length && !this.flushTimer && this.retryMs === 0) {
        this.scheduleFlush(FLUSH_MS);
      }
    }
  }
}

// ---- Shared instances -----------------------------------------------------

type Held = { provider: YConvexProvider; refs: number };
const held = new Map<string, Held>();

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
): YConvexProvider {
  let entry = held.get(docId);
  if (!entry) {
    entry = { provider: new YConvexProvider(client, docId, new Y.Doc()), refs: 0 };
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
    if (entry.refs <= 0 && held.get(docId) === entry) {
      held.delete(docId);
      entry.provider.destroy();
      entry.provider.doc.destroy();
    }
  }, 0);
}
