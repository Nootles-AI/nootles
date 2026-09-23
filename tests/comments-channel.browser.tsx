import * as Y from "yjs";
import { getFunctionName } from "convex/server";
import type { ConvexReactClient } from "convex/react";
import { YConvexProvider } from "../app/lib/sync/YConvexProvider";
import { executeNmlCommands } from "../app/lib/nml/commands";
import { createNmlYDoc, decodeNmlDocument } from "../app/lib/nml/yjs";
import {
  commentText,
  emptyCommentsDocument,
  threadsOf,
  type Thread,
} from "../app/lib/comments/types";

/**
 * Two people on one page's comments document, each with a real
 * `YConvexProvider` over one stand-in Convex backend (per-doc update logs, the
 * presence table, and the derived-data mutations it records but never needs).
 *
 * Beside it, the page's own document on the same backend with default
 * options — so the harness can show the two providers differ exactly where
 * they should: the comments doc syncs, and never touches presence, previews
 * or the context digest.
 */

type Call = { kind: "watch" | "query" | "mutation"; name: string; docId: string | null };

class Backend {
  private logs = new Map<string, Array<{ seq: number; update: ArrayBuffer }>>();
  private watchers = new Map<string, Set<() => void>>();
  readonly calls: Call[] = [];

  /** A doc born holding `initial` as update #1, as `comments.ensureDoc` does. */
  create(docId: string, initial?: Uint8Array) {
    this.logs.set(docId, initial ? [{ seq: 1, update: toBuffer(initial) }] : []);
  }

  private log(docId: string) {
    const log = this.logs.get(docId);
    if (!log) throw new Error(`Not found: ${docId}`);
    return log;
  }

  rows(docId: string): ReadonlyArray<{ seq: number; update: ArrayBuffer }> {
    return this.log(docId);
  }

  private read(name: string, args: Record<string, unknown>) {
    const docId = args.docId as string;
    if (name === "presence:list") return [];
    const log = this.log(docId);
    const seq = log.at(-1)?.seq ?? 0;
    const after = (args.afterSeq as number | undefined) ?? 0;
    if (name === "ydoc:meta") return { seq, snapshotSeq: 0, snapshotParts: 0 };
    if (name === "ydoc:load") {
      return { seq, snapshotSeq: 0, snapshotParts: 0, snapshot: null, updates: log.filter((row) => row.seq > after) };
    }
    if (name === "ydoc:updatesSince") return log.filter((row) => row.seq > after);
    throw new Error(`fixture backend has no query ${name}`);
  }

  client(): ConvexReactClient {
    const record = (kind: Call["kind"], name: string, args: Record<string, unknown>) =>
      this.calls.push({ kind, name, docId: typeof args.docId === "string" ? args.docId : null });
    return {
      watchQuery: (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        record("watch", name, args);
        const key = `${name}|${args.docId}`;
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
        if (name === "ydoc:append") {
          const log = this.log(args.docId as string);
          const chunks = (args.chunks as ArrayBuffer[] | undefined) ?? [args.update as ArrayBuffer];
          for (const update of chunks) log.push({ seq: (log.at(-1)?.seq ?? 0) + 1, update });
          for (const watcher of this.watchers.get(`ydoc:meta|${args.docId}`) ?? []) watcher();
          return log.at(-1)!.seq;
        }
        return null;
      },
    } as unknown as ConvexReactClient;
  }
}

function toBuffer(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

const PAGE_DOC = "page-doc-1";
const COMMENTS_DOC = "comments-doc-1";

const backend = new Backend();
const birth = createNmlYDoc(emptyCommentsDocument(COMMENTS_DOC));
backend.create(COMMENTS_DOC, Y.encodeStateAsUpdate(birth));
birth.destroy();
backend.create(PAGE_DOC);

type Person = { name: string; userId: string; provider: YConvexProvider; page: YConvexProvider };
const people: Record<"a" | "b", Person> = {} as never;

let tx = 0;
async function run(person: Person, commands: Parameters<typeof executeNmlCommands>[0]["commands"]) {
  const id = `${person.userId}-${tx++}`;
  await executeNmlCommands({
    doc: person.provider.doc,
    documentId: COMMENTS_DOC,
    commands,
    origin: { version: 1, transactionId: id, actor: { userId: person.userId, kind: "human" }, command: "harness" },
    idempotencyKey: id,
    authorize: () => true,
  });
}

function threads(person: Person): Thread[] {
  return threadsOf(decodeNmlDocument(person.provider.doc));
}

function render(role: "a" | "b") {
  const list = document.getElementById(`${role}-threads`)!;
  list.replaceChildren(
    ...threads(people[role]).map((thread) => {
      const item = document.createElement("li");
      item.dataset.thread = thread.id;
      item.dataset.status = thread.status;
      item.textContent = `“${thread.anchor.exact}” — ${thread.comments
        .map((c) => `${c.authorId}: ${commentText(c.content)}`)
        .join(" / ")}`;
      return item;
    }),
  );
}

async function join(role: "a" | "b", name: string): Promise<Person> {
  const doc = new Y.Doc();
  const provider = new YConvexProvider(backend.client(), COMMENTS_DOC, doc, { derived: false, presence: false });
  const pageDoc = new Y.Doc();
  const page = new YConvexProvider(backend.client(), PAGE_DOC, pageDoc);
  provider.connect();
  page.connect();
  await Promise.all([provider.whenSynced, page.whenSynced]);
  const person = { name, userId: `user_${name.toLowerCase()}`, provider, page };
  people[role] = person;
  doc.on("update", () => render(role));
  render(role);
  // The same awareness field a real editor sets — it must go nowhere.
  provider.awareness.setLocalStateField("user", { name, color: "#555555" });
  page.awareness.setLocalStateField("user", { name, color: "#555555" });

  const body = document.getElementById(`${role}-body`) as HTMLTextAreaElement;
  document.getElementById(`${role}-start`)!.addEventListener("click", () => {
    const text = body.value;
    body.value = "";
    const n = threads(person).length + 1;
    void run(person, [{
      type: "insertNodes",
      parentId: null,
      nodes: [{
        id: `t${n}-${role}`,
        type: "commentThread",
        props: {
          anchor: { blockId: "p_7f3a", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 8 },
          status: "open",
        },
        children: [{
          id: `c${n}-${role}`,
          type: "comment",
          props: { authorId: person.userId, createdAt: Date.now() },
          content: [{ type: "text", text, marks: [] }],
          children: [],
        }],
      }],
    }]);
  });
  document.getElementById(`${role}-reply`)!.addEventListener("click", () => {
    const text = body.value;
    body.value = "";
    const [first] = threads(person);
    if (!first) return;
    void run(person, [{
      type: "insertNodes",
      parentId: first.id,
      anchor: { afterId: first.comments.at(-1)?.id },
      nodes: [{
        id: `r${tx}-${role}`,
        type: "comment",
        props: { authorId: person.userId, createdAt: Date.now() },
        content: [{ type: "text", text, marks: [] }],
        children: [],
      }],
    }]);
  });
  document.getElementById(`${role}-resolve`)!.addEventListener("click", () => {
    const [first] = threads(person);
    if (!first) return;
    void run(person, [{
      type: "setNodeProps",
      nodeId: first.id,
      patch: { status: "resolved", resolvedBy: person.userId, resolvedAt: Date.now() },
    }]);
  });
  return person;
}

declare global {
  interface Window {
    ntComments: {
      mount(): Promise<void>;
      threads(role: "a" | "b"): Thread[];
      calls(): Call[];
      /** Every Yjs row the backend holds for a doc, rebuilt: what a fresh client would load. */
      reload(docId: string): Thread[];
      leave(): void;
      pageEdit(text: string): void;
      concurrent(): Promise<void>;
    };
  }
}

window.ntComments = {
  async mount() {
    await join("a", "Ada");
    await join("b", "Bram");
  },
  threads: (role) => threads(people[role]),
  calls: () => backend.calls.map((call) => ({ ...call })),
  reload(docId) {
    const doc = new Y.Doc();
    for (const row of backend.rows(docId)) Y.applyUpdate(doc, new Uint8Array(row.update));
    const out = threadsOf(decodeNmlDocument(doc));
    doc.destroy();
    return out;
  },
  leave() {
    for (const person of Object.values(people)) {
      person.provider.disconnect();
      person.page.disconnect();
    }
  },
  pageEdit(text) {
    people.a.page.doc.getText("t").insert(0, text);
  },
  async concurrent() {
    // Both batches are applied locally in this one task, so neither replica
    // has seen the other's before its own flush leaves.
    await Promise.all((["a", "b"] as const).map((role) => run(people[role], [{
      type: "insertNodes",
      parentId: null,
      nodes: [{
        id: `same-instant-${role}`,
        type: "commentThread",
        props: {
          anchor: { blockId: "p_9", exact: "stale", prefix: "", suffix: "", offsetHint: 0 },
          status: "open",
        },
        children: [{
          id: `same-instant-${role}-c`,
          type: "comment",
          props: { authorId: people[role].userId, createdAt: 1 },
          content: [{ type: "text", text: role, marks: [] }],
          children: [],
        }],
      }],
    }])));
  },
};
