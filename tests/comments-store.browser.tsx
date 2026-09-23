import { StrictMode, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { getFunctionName } from "convex/server";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { YConvexProvider } from "../app/lib/sync/YConvexProvider";
import { createNmlYDoc } from "../app/lib/nml/yjs";
import { commentsHistoryFor } from "../app/lib/comments/history";
import { CommentsStore, readThreads } from "../app/lib/comments/store";
import { useCommentsDoc } from "../app/lib/comments/useCommentsDoc";
import { commentText, emptyCommentsDocument, type Thread } from "../app/lib/comments/types";

/**
 * The comments store driven through the hook a surface will use.
 *
 * Ada mounts `useCommentsDoc` for a page nobody has commented on and works a
 * tiny composer — comment, reply, edit, resolve, undo, redo — through the
 * `CommentsStore` and `CommentsHistory` over the document the hook hands
 * her. Bram is a second replica: his own real `YConvexProvider` over the
 * same stand-in backend, the peer the harness asserts on. Vera mounts the
 * hook without the right to comment, on another page, and must never mint
 * anything.
 *
 * The backend answers `comments:docFor` / `comments:ensureDoc` as
 * `convex/comments.ts` does — the doc minted on first write, born holding its
 * NML root as update #1 — plus the `ydoc` log.
 */

type Call = { who: string; kind: "watch" | "query" | "mutation"; name: string; args: Record<string, unknown> };

function toBuffer(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

class Backend {
  private logs = new Map<string, Array<{ seq: number; update: ArrayBuffer }>>();
  private watchers = new Map<string, Set<() => void>>();
  private minted = 0;
  /** pageId → its comments docId, once someone has commented. */
  readonly pages = new Map<string, string | null>([["page-1", null], ["page-2", null], ["page-3", null], ["page-4", null]]);
  readonly calls: Call[] = [];
  /** While set, `comments:ensureDoc` waits for it — a slow first write. */
  held: Promise<void> | null = null;

  rows(docId: string) {
    const log = this.logs.get(docId);
    if (!log) throw new Error(`Not found: ${docId}`);
    return log;
  }

  watcherCount(name: string, key: string): number {
    return this.watchers.get(`${name}|${key}`)?.size ?? 0;
  }

  private notify(name: string, key: string) {
    for (const watcher of [...(this.watchers.get(`${name}|${key}`) ?? [])]) watcher();
  }

  private keyOf(args: Record<string, unknown>): string {
    return String(args.docId ?? args.pageId);
  }

  private read(name: string, args: Record<string, unknown>) {
    if (name === "comments:docFor") return this.pages.get(args.pageId as string) ?? null;
    const log = this.rows(args.docId as string);
    const seq = log.at(-1)?.seq ?? 0;
    const after = (args.afterSeq as number | undefined) ?? 0;
    if (name === "ydoc:meta") return { seq, snapshotSeq: 0, snapshotParts: 0 };
    if (name === "ydoc:load") {
      return { seq, snapshotSeq: 0, snapshotParts: 0, snapshot: null, updates: log.filter((row) => row.seq > after) };
    }
    if (name === "ydoc:updatesSince") return log.filter((row) => row.seq > after);
    throw new Error(`fixture backend has no query ${name}`);
  }

  private ensureDoc(pageId: string): string {
    if (!this.pages.has(pageId)) throw new Error("Not found");
    const existing = this.pages.get(pageId);
    if (existing) return existing;
    const docId = `comments-doc-${++this.minted}`;
    const birth = createNmlYDoc(emptyCommentsDocument(docId));
    this.logs.set(docId, [{ seq: 1, update: toBuffer(Y.encodeStateAsUpdate(birth)) }]);
    birth.destroy();
    this.pages.set(pageId, docId);
    this.notify("comments:docFor", pageId);
    return docId;
  }

  client(who: string): ConvexReactClient {
    const record = (kind: Call["kind"], name: string, args: Record<string, unknown>) =>
      this.calls.push({ who, kind, name, args: { ...args } });
    return {
      watchQuery: (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        record("watch", name, args);
        const key = `${name}|${this.keyOf(args)}`;
        return {
          onUpdate: (callback: () => void) => {
            const set = this.watchers.get(key) ?? new Set();
            set.add(callback);
            this.watchers.set(key, set);
            return () => set.delete(callback);
          },
          localQueryResult: () => this.read(name, args),
        };
      },
      query: async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        record("query", name, args);
        return this.read(name, args);
      },
      mutation: async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        record("mutation", name, args);
        if (name === "comments:ensureDoc") {
          if (this.held) await this.held;
          return this.ensureDoc(args.pageId as string);
        }
        if (name === "ydoc:append") {
          const log = this.rows(args.docId as string);
          const chunks = (args.chunks as ArrayBuffer[] | undefined) ?? [args.update as ArrayBuffer];
          for (const update of chunks) log.push({ seq: (log.at(-1)?.seq ?? 0) + 1, update });
          this.notify("ydoc:meta", args.docId as string);
          return log.at(-1)!.seq;
        }
        throw new Error(`fixture backend has no mutation ${name}`);
      },
    } as unknown as ConvexReactClient;
  }
}

const backend = new Backend();

function ThreadList({ threads, testId }: { threads: Thread[]; testId: string }) {
  return (
    <ul data-testid={testId}>
      {threads.map((thread) => (
        <li key={thread.id} data-thread={thread.id} data-status={thread.status} data-block={thread.anchor.blockId}>
          “{thread.anchor.exact}” [{thread.status}] —{" "}
          {thread.comments
            .map((comment) => `${comment.authorId}: ${commentText(comment.content)}${comment.editedAt ? " (edited)" : ""}`)
            .join(" / ")}
        </li>
      ))}
    </ul>
  );
}

const NO_HISTORY = { canUndo: false, canRedo: false };
const noSubscription = () => () => {};

function Composer({ who, userId, pageId, canComment }: { who: string; userId: string; pageId: string; canComment: boolean }) {
  const comments = useCommentsDoc(pageId as Id<"pages">, { canComment });
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const history = useMemo(
    () => (comments.doc ? commentsHistoryFor(comments.doc, { localUserId: userId }) : null),
    [comments.doc, userId],
  );
  const state = useSyncExternalStore(
    history ? (listener) => history.subscribe(listener) : noSubscription,
    () => history?.getState() ?? NO_HISTORY,
    () => NO_HISTORY,
  );

  const act = async (action: (store: CommentsStore) => Promise<unknown>) => {
    setError(null);
    try {
      const doc = await comments.ensure();
      await action(new CommentsStore(doc, { actor: { userId, kind: "human" }, authorize: () => canComment }));
      setBody("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  const [first] = comments.threads;

  return (
    <section>
      <h2>{who}</h2>
      <p id={`${who}-status`}>{comments.status}</p>
      <textarea id={`${who}-body`} value={body} onChange={(event) => setBody(event.target.value)} />
      <div>
        <button id={`${who}-comment`} onClick={() => act((store) => store.createThread({
          anchor: { blockId: "p_7f3a", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 8 },
          body,
          authorId: userId,
        }))}>Comment</button>
        <button id={`${who}-reply`} disabled={!first} onClick={() => act((store) => store.reply({ threadId: first.id, body, authorId: userId }))}>Reply</button>
        <button id={`${who}-edit`} disabled={!first} onClick={() => act((store) => store.editComment({ commentId: first.comments[0].id, body, editorId: userId }))}>Edit first</button>
        <button id={`${who}-resolve`} disabled={!first} onClick={() => act((store) =>
          first.status === "open" ? store.resolve({ threadId: first.id, by: userId }) : store.reopen({ threadId: first.id }))}>
          {first?.status === "resolved" ? "Reopen" : "Resolve"}
        </button>
        <button id={`${who}-undo`} disabled={!state.canUndo} onClick={() => history?.undo()}>Undo</button>
        <button id={`${who}-redo`} disabled={!state.canRedo} onClick={() => history?.redo()}>Redo</button>
      </div>
      {error ? <p id={`${who}-error`}>{error}</p> : null}
      <ThreadList threads={comments.threads} testId={`${who}-threads`} />
    </section>
  );
}

// ---- Bram: a second replica, outside React ----------------------------------

type Peer = { provider: YConvexProvider; store: CommentsStore };
let bram: Peer | null = null;

function renderBram() {
  const list = document.getElementById("bram-threads")!;
  list.replaceChildren(
    ...(bram ? readThreads(bram.provider.doc) : []).map((thread) => {
      const item = document.createElement("li");
      item.dataset.thread = thread.id;
      item.dataset.status = thread.status;
      item.dataset.block = thread.anchor.blockId;
      item.textContent = `“${thread.anchor.exact}” [${thread.status}] — ${thread.comments
        .map((comment) => `${comment.authorId}: ${commentText(comment.content)}${comment.editedAt ? " (edited)" : ""}`)
        .join(" / ")}`;
      return item;
    }),
  );
}

async function joinBram(docId: string) {
  const provider = new YConvexProvider(backend.client("bram"), docId, new Y.Doc(), { derived: false, presence: false });
  provider.connect();
  await provider.whenSynced;
  bram = { provider, store: new CommentsStore(provider.doc, { actor: { userId: "user_bram", kind: "human" }, authorize: () => true }) };
  provider.doc.on("update", renderBram);
  renderBram();
  const body = document.getElementById("bram-body") as HTMLTextAreaElement;
  document.getElementById("bram-reply")!.addEventListener("click", () => {
    const [first] = readThreads(provider.doc);
    const text = body.value;
    body.value = "";
    if (first) void bram!.store.reply({ threadId: first.id, body: text, authorId: "user_bram" });
  });
}

// ---- Mounting -----------------------------------------------------------------

/** Cara's panel follows the page she is on; she can move while a write is in flight. */
function Switcher() {
  const [pageId, setPageId] = useState("page-3");
  return (
    <>
      <button id="cara-switch" onClick={() => setPageId("page-4")}>Go to page 4</button>
      <p id="cara-page">{pageId}</p>
      <Composer who="cara" userId="user_cara" pageId={pageId} canComment />
    </>
  );
}

let release: (() => void) | null = null;

let adaRoot: Root | null = null;

function mount() {
  adaRoot = createRoot(document.getElementById("ada")!);
  adaRoot.render(
    <StrictMode>
      <ConvexProvider client={backend.client("ada")}>
        <Composer who="ada" userId="user_ada" pageId="page-1" canComment />
      </ConvexProvider>
    </StrictMode>,
  );
  createRoot(document.getElementById("vera")!).render(
    <StrictMode>
      <ConvexProvider client={backend.client("vera")}>
        <Composer who="vera" userId="user_vera" pageId="page-2" canComment={false} />
      </ConvexProvider>
    </StrictMode>,
  );
}

declare global {
  interface Window {
    ntStore: {
      mount(): void;
      mountViewer(): void;
      mountSwitcher(): void;
      holdEnsure(): void;
      releaseEnsure(): void;
      joinBram(): Promise<void>;
      unmountAda(): void;
      bramThreads(): Thread[];
      bramRehome(blockId: string): Promise<boolean>;
      calls(): Array<Omit<Call, "args"> & { args: Record<string, unknown> }>;
      pages(): Record<string, string | null>;
      reload(docId: string): Thread[];
      watchers(name: string, key: string): number;
    };
  }
}

window.ntStore = {
  mount,
  mountSwitcher() {
    const host = document.createElement("div");
    host.id = "cara";
    document.body.append(host);
    createRoot(host).render(
      <StrictMode>
        <ConvexProvider client={backend.client("cara")}>
          <Switcher />
        </ConvexProvider>
      </StrictMode>,
    );
  },
  holdEnsure() {
    backend.held = new Promise((resolve) => (release = resolve));
  },
  releaseEnsure() {
    release?.();
    backend.held = null;
  },
  /** A viewer opening page-1 once it has comments, on her own client. */
  mountViewer() {
    const host = document.createElement("div");
    host.id = "viewer";
    document.body.append(host);
    createRoot(host).render(
      <StrictMode>
        <ConvexProvider client={backend.client("viewer")}>
          <Composer who="viewer" userId="user_vic" pageId="page-1" canComment={false} />
        </ConvexProvider>
      </StrictMode>,
    );
  },
  async joinBram() {
    const docId = backend.pages.get("page-1");
    if (!docId) throw new Error("page-1 has no comments yet");
    await joinBram(docId);
  },
  unmountAda() {
    adaRoot?.unmount();
    adaRoot = null;
  },
  bramThreads: () => (bram ? readThreads(bram.provider.doc) : []),
  bramRehome(blockId) {
    const [first] = readThreads(bram!.provider.doc);
    return bram!.store.applyAnchorWrite(first.id, { anchor: { blockId } });
  },
  calls: () => backend.calls.map((call) => ({ ...call, args: { ...call.args } })),
  pages: () => Object.fromEntries(backend.pages),
  reload(docId) {
    const doc = new Y.Doc();
    for (const row of backend.rows(docId)) Y.applyUpdate(doc, new Uint8Array(row.update));
    const threads = readThreads(doc);
    doc.destroy();
    return threads;
  },
  watchers: (name, key) => backend.watcherCount(name, key),
};
