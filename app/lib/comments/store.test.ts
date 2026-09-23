import * as Y from "yjs";
import { beforeEach, describe, expect, it } from "vitest";
import { NmlCommandConflict } from "@/app/lib/nml/commands";
import { validateDocument } from "@/app/lib/nml/validate";
import { createNmlYDoc, decodeNmlDocument, isNmlOrigin, NML_YJS_ROOT, type NmlTransactionOrigin } from "@/app/lib/nml/yjs";
import { CommentsHistory } from "./history";
import {
  applyAnchorWrite,
  CommentsStore,
  CommentsStoreError,
  observeThreads,
  readThreads,
  threadsSnapshot,
} from "./store";
import { commentText, emptyCommentsDocument, type CommentAnchor, type Thread } from "./types";

const DOC = "comments-doc";
const ANCHOR: CommentAnchor = { blockId: "p_7f3a", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 8 };

const fresh = () => createNmlYDoc(emptyCommentsDocument(DOC));

/** A second replica of `source`, with a pinned client id when the order of a merge matters. */
function replica(source: Y.Doc, clientID?: number): Y.Doc {
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

/** Exchange everything each side lacks, as the provider eventually does. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), "remote");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "remote");
}

let minted = 0;
let clock = 1_727_000_000_000;
beforeEach(() => {
  minted = 0;
});

/** Ids are unique across every store in a test, as random ones would be. */
function store(doc: Y.Doc, userId = "user_ada", options: { kind?: "human" | "model"; allow?: () => boolean } = {}) {
  return new CommentsStore(doc, {
    actor: { userId, kind: options.kind ?? "human" },
    authorize: options.allow ?? (() => true),
    createId: () => `id-${++minted}`,
    now: () => ++clock,
  });
}

function updates(doc: Y.Doc): { count: number; stop: () => void } {
  const counter = { count: 0, stop: () => {} };
  const onUpdate = () => void counter.count++;
  doc.on("update", onUpdate);
  counter.stop = () => doc.off("update", onUpdate);
  return counter;
}

function origins(doc: Y.Doc): NmlTransactionOrigin[] {
  const seen: NmlTransactionOrigin[] = [];
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (isNmlOrigin(transaction.origin)) seen.push(transaction.origin);
  });
  return seen;
}

function expectValid(doc: Y.Doc) {
  expect(validateDocument(decodeNmlDocument(doc))).toEqual([]);
}

const summary = (threads: Thread[]) =>
  threads.map((thread) => ({
    id: thread.id,
    status: thread.status,
    comments: thread.comments.map((comment) => `${comment.authorId}: ${commentText(comment.content)}`),
  }));

describe("reading", () => {
  it("reads nothing from a document whose root has not synced", () => {
    const doc = new Y.Doc();
    expect(readThreads(doc)).toEqual([]);
    expect(threadsSnapshot(doc)).toEqual([]);
  });

  it("refuses a page document", () => {
    const page = createNmlYDoc({ schemaVersion: 1, documentId: "page", blocks: [] });
    expect(() => readThreads(page)).toThrow("Not a comments document.");
  });

  it("lists threads in document order, comments in reply order", async () => {
    const doc = fresh();
    const ada = store(doc);
    const first = await ada.createThread({ anchor: ANCHOR, body: "One", authorId: "user_ada" });
    const second = await ada.createThread({ anchor: { ...ANCHOR, exact: "Friday" }, body: "Two", authorId: "user_ada" });
    await ada.reply({ threadId: first, body: "One, again", authorId: "user_ada" });
    expect(readThreads(doc).map((thread) => thread.id)).toEqual([first, second]);
    expect(summary(readThreads(doc))[0].comments).toEqual(["user_ada: One", "user_ada: One, again"]);
  });

  it("keeps one snapshot until the threads change, and tells subscribers when they do", async () => {
    const doc = fresh();
    const ada = store(doc);
    const empty = threadsSnapshot(doc);
    expect(threadsSnapshot(doc)).toBe(empty);
    let heard = 0;
    const stop = observeThreads(doc, () => heard++);
    const id = await ada.createThread({ anchor: ANCHOR, body: "Hello", authorId: "user_ada" });
    expect(heard).toBe(1);
    const one = threadsSnapshot(doc);
    expect(one).not.toBe(empty);
    expect(one.map((thread) => thread.id)).toEqual([id]);
    expect(threadsSnapshot(doc)).toBe(one);

    // A change to another root is not a change to the threads.
    doc.getMap("elsewhere").set("x", 1);
    expect(heard).toBe(1);
    expect(threadsSnapshot(doc)).toBe(one);

    // A remote change is heard like a local one.
    const peer = replica(doc);
    await store(peer, "user_bram").reply({ threadId: id, body: "Hi", authorId: "user_bram" });
    sync(doc, peer);
    expect(heard).toBe(2);
    expect(threadsSnapshot(doc)[0].comments).toHaveLength(2);

    stop();
    await ada.resolve({ threadId: id, by: "user_ada" });
    expect(heard).toBe(2);
    expect(threadsSnapshot(doc)[0].status).toBe("resolved");
  });

  it("keeps the last good snapshot through a state that will not decode", async () => {
    const doc = fresh();
    await store(doc).createThread({ anchor: ANCHOR, body: "Hello", authorId: "user_ada" });
    const good = threadsSnapshot(doc);
    doc.getMap(NML_YJS_ROOT).set("kind", "unheard-of");
    expect(() => readThreads(doc)).toThrow();
    expect(threadsSnapshot(doc)).toBe(good);
  });
});

describe("writing", () => {
  it("starts a thread as one attributed human transaction, and the document stays valid", async () => {
    const doc = fresh();
    const seen = origins(doc);
    const counter = updates(doc);
    const id = await store(doc).createThread({ anchor: ANCHOR, body: "Is Friday realistic?", authorId: "user_ada", at: 42 });
    expect(counter.count).toBe(1);
    expect(seen).toEqual([expect.objectContaining({ actor: { userId: "user_ada", kind: "human" }, command: "comments.create-thread" })]);
    expect(readThreads(doc)).toEqual([{
      id,
      anchor: ANCHOR,
      status: "open",
      ambiguous: false,
      comments: [{ id: "id-2", authorId: "user_ada", createdAt: 42, content: [{ type: "text", text: "Is Friday realistic?", marks: [] }] }],
    }]);
    expectValid(doc);
  });

  it("mints ids with crypto.randomUUID when no createId is given", async () => {
    const doc = fresh();
    const plain = new CommentsStore(doc, { actor: { userId: "user_ada", kind: "human" }, authorize: () => true });
    const id = await plain.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readThreads(doc)[0].comments[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a mention as plain text and rich content as given", async () => {
    const doc = fresh();
    const ada = store(doc);
    await ada.createThread({ anchor: ANCHOR, body: "@Bram can you check?", authorId: "user_ada" });
    await ada.reply({
      threadId: readThreads(doc)[0].id,
      authorId: "user_ada",
      body: [
        { type: "text", text: "See ", marks: [] },
        { type: "text", text: "this", marks: ["bold"] },
        { type: "link", href: "https://example.com", content: [{ type: "text", text: " link", marks: [] }] },
      ],
    });
    const [thread] = readThreads(doc);
    expect(thread.comments[0].content).toEqual([{ type: "text", text: "@Bram can you check?", marks: [] }]);
    expect(commentText(thread.comments[1].content)).toBe("See this link");
    expect(thread.comments[1].content[1]).toEqual({ type: "text", text: "this", marks: ["bold"] });
    expectValid(doc);
  });

  it("refuses an empty body before writing anything", async () => {
    const doc = fresh();
    const counter = updates(doc);
    const ada = store(doc);
    await expect(ada.createThread({ anchor: ANCHOR, body: "   ", authorId: "user_ada" })).rejects.toMatchObject({ code: "empty_body" });
    await expect(ada.createThread({ anchor: ANCHOR, body: [], authorId: "user_ada" })).rejects.toBeInstanceOf(CommentsStoreError);
    expect(counter.count).toBe(0);
  });

  it("asks authorize before every write, and writes nothing when refused", async () => {
    const doc = fresh();
    const id = await store(doc).createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    const counter = updates(doc);
    const viewer = store(doc, "user_vera", { allow: () => false });
    const refused = { code: "unauthorized" };
    await expect(viewer.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_vera" })).rejects.toMatchObject(refused);
    await expect(viewer.reply({ threadId: id, body: "Hi", authorId: "user_vera" })).rejects.toMatchObject(refused);
    await expect(viewer.resolve({ threadId: id, by: "user_vera" })).rejects.toMatchObject(refused);
    await expect(viewer.deleteThread({ threadId: id })).rejects.toMatchObject(refused);
    await expect(viewer.applyAnchorWrite(id, { anchor: { blockId: "p_2" } })).rejects.toBeInstanceOf(NmlCommandConflict);
    expect(counter.count).toBe(0);
  });

  it("an asynchronous authorize is awaited", async () => {
    const doc = fresh();
    const ada = store(doc, "user_ada", { allow: () => true });
    const slow = new CommentsStore(doc, { actor: { userId: "user_ada", kind: "human" }, authorize: async () => false });
    await expect(slow.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" })).rejects.toMatchObject({ code: "unauthorized" });
    await ada.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    expect(readThreads(doc)).toHaveLength(1);
  });

  it("refuses to write before the document has loaded", async () => {
    await expect(store(new Y.Doc()).createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" }))
      .rejects.toMatchObject({ code: "not_loaded" });
  });

  it("refuses an anchor the NML profile refuses, and leaves the document as it was", async () => {
    const doc = fresh();
    const counter = updates(doc);
    await expect(store(doc).createThread({ anchor: { ...ANCHOR, exact: "" }, body: "Hi", authorId: "user_ada" }))
      .rejects.toThrow("Too small");
    expect(counter.count).toBe(0);
    expect(readThreads(doc)).toEqual([]);
  });

  it("creation is idempotent on its ids: a replay returns the thread, and writes nothing", async () => {
    const doc = fresh();
    const ada = store(doc);
    const input = { anchor: ANCHOR, body: "Once", authorId: "user_ada", threadId: "t-replay", commentId: "c-replay", at: 7 };
    expect(await ada.createThread(input)).toBe("t-replay");
    const counter = updates(doc);
    expect(await ada.createThread(input)).toBe("t-replay");
    expect(await ada.reply({ threadId: "t-replay", body: "Reply", authorId: "user_ada", commentId: "r-replay", at: 8 })).toBe("r-replay");
    expect(counter.count).toBe(1);
    expect(await ada.reply({ threadId: "t-replay", body: "Reply", authorId: "user_ada", commentId: "r-replay", at: 8 })).toBe("r-replay");
    expect(counter.count).toBe(1);
    expect(readThreads(doc)[0].comments.map((comment) => comment.id)).toEqual(["c-replay", "r-replay"]);
    // A replay finds the id already there, whatever else changed meanwhile.
    expect(await ada.createThread({ ...input, body: "Twice", at: 9 })).toBe("t-replay");
    expect(counter.count).toBe(1);
    expect(commentText(readThreads(doc)[0].comments[0].content)).toBe("Once");
  });

  it("replaying a reply that reopened its thread returns it, written once", async () => {
    const doc = fresh();
    const ada = store(doc);
    const id = await ada.createThread({ anchor: ANCHOR, body: "Opening", authorId: "user_ada" });
    await ada.resolve({ threadId: id, by: "user_ada" });
    const input = { threadId: id, body: "Reopening", authorId: "user_bram", commentId: "r1", at: 5 };
    expect(await ada.reply(input)).toBe("r1");
    const counter = updates(doc);
    expect(await ada.reply(input)).toBe("r1");
    expect(counter.count).toBe(0);
    expect(readThreads(doc)[0].comments.map((comment) => comment.id)).toEqual([readThreads(doc)[0].comments[0].id, "r1"]);
  });

  it("a thread resolved while authorize was thinking is planned again, and the reply still reopens it", async () => {
    const doc = fresh();
    const id = await store(doc).createThread({ anchor: ANCHOR, body: "Opening", authorId: "user_ada" });
    const peer = replica(doc);
    await store(peer, "user_bram").resolve({ threadId: id, by: "user_bram" });
    let asked = 0;
    const slow = new CommentsStore(doc, {
      actor: { userId: "user_ada", kind: "human" },
      authorize: async () => {
        // The collaborator's resolve arrives during the first check.
        if (asked++ === 0) sync(doc, peer);
        return true;
      },
    });
    await slow.reply({ threadId: id, body: "Not yet", authorId: "user_ada" });
    expect(asked).toBe(2);
    const [thread] = readThreads(doc);
    expect(thread.status).toBe("open");
    expect(thread.comments.map((comment) => commentText(comment.content))).toEqual(["Opening", "Not yet"]);
    expectValid(doc);
  });

  it("gives up on a document that never holds still", async () => {
    const doc = fresh();
    const id = await store(doc).createThread({ anchor: ANCHOR, body: "Opening", authorId: "user_ada" });
    const restless = new CommentsStore(doc, {
      actor: { userId: "user_ada", kind: "human" },
      authorize: async () => {
        doc.getMap("elsewhere").set("tick", Math.random());
        return true;
      },
    });
    await expect(restless.reply({ threadId: id, body: "Hello?", authorId: "user_ada" })).rejects.toThrow("kept changing");
    expect(readThreads(doc)[0].comments).toHaveLength(1);
  });

  it("stores a body as the document will read it back", async () => {
    const doc = fresh();
    const ada = store(doc);
    await ada.createThread({
      anchor: ANCHOR,
      authorId: "user_ada",
      body: [{ type: "text", text: "Two  spaces\nand a line", marks: [] }, { type: "text", text: " joined", marks: [] }],
    });
    const [comment] = readThreads(doc)[0].comments;
    expect(comment.content).toEqual([{ type: "text", text: "Two spaces and a line joined", marks: [] }]);
    const counter = updates(doc);
    expect(await ada.editComment({ commentId: comment.id, body: "Two spaces and a line joined", editorId: "user_ada" })).toBe(false);
    expect(await ada.editComment({ commentId: comment.id, body: "Two  spaces and\ta line joined", editorId: "user_ada" })).toBe(false);
    expect(counter.count).toBe(0);
  });

  it("an unchanged rich body is no edit, whatever order its keys were written in", async () => {
    const doc = fresh();
    const ada = store(doc);
    await ada.createThread({
      anchor: ANCHOR,
      authorId: "user_ada",
      body: [{ type: "link", href: "https://example.com", content: [{ type: "text", text: "a link", marks: ["bold"] }] }],
    });
    const commentId = readThreads(doc)[0].comments[0].id;
    const counter = updates(doc);
    expect(await ada.editComment({
      commentId,
      editorId: "user_ada",
      body: [{ content: [{ marks: ["bold"], text: "a link", type: "text" }], href: "https://example.com", type: "link" }],
    })).toBe(false);
    expect(counter.count).toBe(0);
  });

  it("replies at the end of the thread, and a reply to a resolved thread reopens it", async () => {
    const doc = fresh();
    const ada = store(doc);
    const bram = store(doc, "user_bram");
    const id = await ada.createThread({ anchor: ANCHOR, body: "First", authorId: "user_ada" });
    await bram.reply({ threadId: id, body: "Second", authorId: "user_bram" });
    await ada.resolve({ threadId: id, by: "user_ada" });
    expect(readThreads(doc)[0].status).toBe("resolved");
    const seen = origins(doc);
    await bram.reply({ threadId: id, body: "Third, and not done", authorId: "user_bram" });
    expect(seen).toHaveLength(1);
    const [thread] = readThreads(doc);
    expect(summary([thread])).toEqual([{ id, status: "open", comments: ["user_ada: First", "user_bram: Second", "user_bram: Third, and not done"] }]);
    expect(thread).not.toHaveProperty("resolvedBy");
    expectValid(doc);
  });

  it("refuses a reply to a thread that is not there", async () => {
    await expect(store(fresh()).reply({ threadId: "gone", body: "Hi", authorId: "user_ada" })).rejects.toMatchObject({ code: "missing" });
  });

  it("edits a comment in place for its author, stamping editedAt", async () => {
    const doc = fresh();
    const ada = store(doc);
    const id = await ada.createThread({
      anchor: ANCHOR,
      authorId: "user_ada",
      body: [{ type: "text", text: "Bold ", marks: ["bold"] }, { type: "text", text: "claim", marks: [] }],
    });
    const commentId = readThreads(doc)[0].comments[0].id;
    expect(await ada.editComment({ commentId, body: "A softer claim", editorId: "user_ada", at: 99 })).toBe(true);
    const [comment] = readThreads(doc)[0].comments;
    expect(comment).toMatchObject({ id: commentId, editedAt: 99, content: [{ type: "text", text: "A softer claim", marks: [] }] });
    expect(readThreads(doc)[0].id).toBe(id);
    expectValid(doc);
  });

  it("an edit to the same words writes nothing", async () => {
    const doc = fresh();
    const ada = store(doc);
    await ada.createThread({ anchor: ANCHOR, body: "Same", authorId: "user_ada" });
    const counter = updates(doc);
    expect(await ada.editComment({ commentId: readThreads(doc)[0].comments[0].id, body: "Same", editorId: "user_ada" })).toBe(false);
    expect(counter.count).toBe(0);
    expect(readThreads(doc)[0].comments[0]).not.toHaveProperty("editedAt");
  });

  it("refuses to edit or delete another person's comment", async () => {
    const doc = fresh();
    await store(doc).createThread({ anchor: ANCHOR, body: "Mine", authorId: "user_ada" });
    const commentId = readThreads(doc)[0].comments[0].id;
    const bram = store(doc, "user_bram");
    const counter = updates(doc);
    await expect(bram.editComment({ commentId, body: "Yours now", editorId: "user_bram" })).rejects.toMatchObject({ code: "not_author" });
    await expect(bram.deleteComment({ commentId, by: "user_bram" })).rejects.toMatchObject({ code: "not_author" });
    await expect(bram.editComment({ commentId: "nope", body: "x", editorId: "user_bram" })).rejects.toMatchObject({ code: "missing" });
    expect(counter.count).toBe(0);
  });

  it("deleting a reply removes the reply; deleting the first comment removes the thread", async () => {
    const doc = fresh();
    const ada = store(doc);
    const bram = store(doc, "user_bram");
    const id = await ada.createThread({ anchor: ANCHOR, body: "Opening", authorId: "user_ada" });
    const reply = await bram.reply({ threadId: id, body: "Reply", authorId: "user_bram" });
    expect(await bram.deleteComment({ commentId: reply, by: "user_bram" })).toBe("comment");
    expect(summary(readThreads(doc))).toEqual([{ id, status: "open", comments: ["user_ada: Opening"] }]);
    await bram.reply({ threadId: id, body: "Another", authorId: "user_bram" });
    expect(await ada.deleteComment({ commentId: readThreads(doc)[0].comments[0].id, by: "user_ada" })).toBe("thread");
    expect(readThreads(doc)).toEqual([]);
    expectValid(doc);
  });

  it("resolves with who and when, reopens clearing both, and a repeat is a no-op", async () => {
    const doc = fresh();
    const ada = store(doc);
    const id = await ada.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    expect(await ada.resolve({ threadId: id, by: "user_bram", at: 5 })).toBe(true);
    expect(readThreads(doc)[0]).toMatchObject({ status: "resolved", resolvedBy: "user_bram", resolvedAt: 5 });
    expectValid(doc);
    const counter = updates(doc);
    expect(await ada.resolve({ threadId: id, by: "user_ada" })).toBe(false);
    expect(counter.count).toBe(0);
    expect(await ada.reopen({ threadId: id })).toBe(true);
    const [thread] = readThreads(doc);
    expect(thread.status).toBe("open");
    expect(thread).not.toHaveProperty("resolvedBy");
    expect(thread).not.toHaveProperty("resolvedAt");
    expect(await ada.reopen({ threadId: id })).toBe(false);
    expect(counter.count).toBe(1);
    expectValid(doc);
    await expect(ada.resolve({ threadId: "gone", by: "user_ada" })).rejects.toMatchObject({ code: "missing" });
    await expect(ada.reopen({ threadId: "gone" })).rejects.toMatchObject({ code: "missing" });
  });

  it("deletes a whole thread", async () => {
    const doc = fresh();
    const ada = store(doc);
    const keep = await ada.createThread({ anchor: ANCHOR, body: "Keep", authorId: "user_ada" });
    const drop = await ada.createThread({ anchor: ANCHOR, body: "Drop", authorId: "user_ada" });
    await store(doc, "user_bram").reply({ threadId: drop, body: "Reply", authorId: "user_bram" });
    await ada.deleteThread({ threadId: drop });
    expect(readThreads(doc).map((thread) => thread.id)).toEqual([keep]);
    await expect(ada.deleteThread({ threadId: drop })).rejects.toMatchObject({ code: "missing" });
    expectValid(doc);
  });

  it("writes as the assistant when the actor is a model", async () => {
    const doc = fresh();
    const seen = origins(doc);
    await store(doc, "user_ada", { kind: "model" }).createThread({ anchor: ANCHOR, body: "Suggested", authorId: "user_ada" });
    expect(seen[0].actor).toEqual({ userId: "user_ada", kind: "model" });
  });

  it("marks what the assistant writes as via the assistant, and nothing a person writes", async () => {
    const doc = fresh();
    const model = store(doc, "user_ada", { kind: "model" });
    const person = store(doc, "user_ada");
    const threadId = await model.createThread({ anchor: ANCHOR, body: "Suggested", authorId: "user_ada" });
    await person.reply({ threadId, body: "Thanks", authorId: "user_ada" });
    await model.reply({ threadId, body: "Done", authorId: "user_ada" });
    expect(readThreads(doc)[0].comments.map((c) => [commentText(c.content), c.via ?? null])).toEqual([
      ["Suggested", "assistant"],
      ["Thanks", null],
      ["Done", "assistant"],
    ]);
    // Editing keeps the mark: the words were the assistant's to begin with.
    await person.editComment({ commentId: readThreads(doc)[0].comments[0].id, body: "Suggested, amended", editorId: "user_ada" });
    expect(readThreads(doc)[0].comments[0].via).toBe("assistant");
    expectValid(doc);
  });
});

describe("anchor maintenance", () => {
  async function withThread() {
    const doc = fresh();
    const ada = store(doc);
    const id = await ada.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    return { doc, ada, id };
  }
  const anchorOf = (doc: Y.Doc) => readThreads(doc)[0];

  it("rewrites exact and its context as one system write", async () => {
    const { doc, ada, id } = await withThread();
    const seen = origins(doc);
    const counter = updates(doc);
    expect(await ada.applyAnchorWrite(id, { anchor: { exact: "by Thursday", suffix: " if they" } })).toBe(true);
    expect(counter.count).toBe(1);
    expect(seen.map((origin) => [origin.actor.kind, origin.command])).toEqual([["system", "comments.anchor"]]);
    expect(anchorOf(doc).anchor).toEqual({ ...ANCHOR, exact: "by Thursday", suffix: " if they" });
    expectValid(doc);
  });

  it("re-homes to another block", async () => {
    const { doc, ada, id } = await withThread();
    await ada.applyAnchorWrite(id, { anchor: { blockId: "p_moved", offsetHint: 0 } });
    expect(anchorOf(doc).anchor).toEqual({ ...ANCHOR, blockId: "p_moved", offsetHint: 0 });
  });

  it("a write equal to what the thread says makes no transaction at all", async () => {
    const { doc, ada, id } = await withThread();
    await ada.applyAnchorWrite(id, { ambiguous: true, orphanedAt: 10 });
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    const counter = updates(doc);
    for (const write of [
      {},
      { anchor: {} },
      { anchor: { ...ANCHOR } },
      { anchor: { exact: ANCHOR.exact, blockId: undefined } },
      { ambiguous: true },
      { orphanedAt: 10 },
      // Already orphaned: the first time it was seen stands.
      { orphanedAt: 99 },
    ]) {
      expect(await ada.applyAnchorWrite(id, write)).toBe(false);
    }
    expect(counter.count).toBe(0);
    expect(transactions).toBe(0);
    expect(anchorOf(doc)).toMatchObject({ ambiguous: true, orphanedAt: 10 });
  });

  it("sets and clears ambiguity and orphaning", async () => {
    const { doc, ada, id } = await withThread();
    await ada.applyAnchorWrite(id, { ambiguous: true, orphanedAt: 10 });
    expect(anchorOf(doc)).toMatchObject({ ambiguous: true, orphanedAt: 10 });
    expectValid(doc);
    await ada.applyAnchorWrite(id, { ambiguous: false, orphanedAt: null });
    expect(anchorOf(doc).ambiguous).toBe(false);
    expect(anchorOf(doc)).not.toHaveProperty("orphanedAt");
    const counter = updates(doc);
    expect(await ada.applyAnchorWrite(id, { ambiguous: false, orphanedAt: null })).toBe(false);
    expect(counter.count).toBe(0);
    expectValid(doc);
  });

  it("a thread deleted meanwhile is nothing to maintain", async () => {
    const { doc, ada, id } = await withThread();
    await ada.deleteThread({ threadId: id });
    const counter = updates(doc);
    expect(await ada.applyAnchorWrite(id, { orphanedAt: 5 })).toBe(false);
    expect(counter.count).toBe(0);
  });

  it("persists nothing under a review fork: orphanedAt set or cleared, a rewrite, a re-home", async () => {
    const { doc, ada, id } = await withThread();
    const counter = updates(doc);
    await expect(ada.applyAnchorWrite(id, { orphanedAt: 5 }, { forked: true })).rejects.toMatchObject({ code: "forked" });
    await expect(ada.applyAnchorWrite(id, { orphanedAt: null, anchor: { blockId: "p_2" } }, { forked: true })).rejects.toMatchObject({ code: "forked" });
    await expect(applyAnchorWrite(doc, id, { orphanedAt: 5 }, { userId: "user_ada", authorize: () => true, forked: true })).rejects.toBeInstanceOf(CommentsStoreError);
    expect(counter.count).toBe(0);
    expect(anchorOf(doc)).not.toHaveProperty("orphanedAt");
    // Nor any other change: a rewrite or re-home found in the fork's text is
    // the proposal's, not the document's.
    await expect(ada.applyAnchorWrite(id, { anchor: { exact: "by Friday!" } }, { forked: true })).rejects.toMatchObject({ code: "forked" });
    await expect(ada.applyAnchorWrite(id, { anchor: { blockId: "p_2" }, ambiguous: true }, { forked: true })).rejects.toMatchObject({ code: "forked" });
    // A write that would change nothing is still nothing.
    expect(await ada.applyAnchorWrite(id, { anchor: { ...ANCHOR }, ambiguous: false }, { forked: true })).toBe(false);
    expect(counter.count).toBe(0);
    expect(anchorOf(doc).anchor).toEqual(ANCHOR);
    // Outside a fork, the same writes land.
    expect(await ada.applyAnchorWrite(id, { orphanedAt: 5 }, { forked: false })).toBe(true);
    expect(await ada.applyAnchorWrite(id, { anchor: { exact: "by Friday!" } })).toBe(true);
    expect(anchorOf(doc)).toMatchObject({ orphanedAt: 5, anchor: { exact: "by Friday!" } });
  });

  it("two replicas making the same write concurrently converge, in a bounded number of updates", async () => {
    const { doc: a, id } = await withThread();
    const b = replica(a);
    const updatesA = updates(a);
    const updatesB = updates(b);
    const write = { anchor: { blockId: "p_pasted", offsetHint: 3 }, orphanedAt: null, ambiguous: false } as const;
    expect(await store(a).applyAnchorWrite(id, write)).toBe(true);
    expect(await store(b, "user_bram").applyAnchorWrite(id, write)).toBe(true);
    expect([updatesA.count, updatesB.count]).toEqual([1, 1]);
    sync(a, b);
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
    expect(anchorOf(a).anchor).toEqual({ ...ANCHOR, blockId: "p_pasted", offsetHint: 3 });
    // Each side took the other's one update, and now neither has anything to write.
    expect([updatesA.count, updatesB.count]).toEqual([2, 2]);
    expect(await store(a).applyAnchorWrite(id, write)).toBe(false);
    expect(await store(b, "user_bram").applyAnchorWrite(id, write)).toBe(false);
    expect([updatesA.count, updatesB.count]).toEqual([2, 2]);
    expectValid(a);
  });

  it("two replicas orphaning at different moments converge on one stamp", async () => {
    const { doc: a, id } = await withThread();
    const b = replica(a);
    await store(a).applyAnchorWrite(id, { orphanedAt: 100 });
    await store(b, "user_bram").applyAnchorWrite(id, { orphanedAt: 200 });
    sync(a, b);
    expect(anchorOf(a).orphanedAt).toBe(anchorOf(b).orphanedAt);
    expect([100, 200]).toContain(anchorOf(a).orphanedAt);
  });

  it("a re-home racing a reply keeps both", async () => {
    const { doc: a, id } = await withThread();
    const b = replica(a);
    await store(a).applyAnchorWrite(id, { anchor: { blockId: "p_elsewhere" } });
    await store(b, "user_bram").reply({ threadId: id, body: "Reply", authorId: "user_bram" });
    sync(a, b);
    for (const doc of [a, b]) {
      expect(anchorOf(doc).anchor.blockId).toBe("p_elsewhere");
      expect(anchorOf(doc).comments).toHaveLength(2);
    }
  });
});

describe("two replicas", () => {
  it("concurrent replies both land, in one order on both replicas", async () => {
    const a = fresh();
    const id = await store(a).createThread({ anchor: ANCHOR, body: "Opening", authorId: "user_ada" });
    const b = replica(a);
    await store(a).reply({ threadId: id, body: "From Ada", authorId: "user_ada" });
    await store(b, "user_bram").reply({ threadId: id, body: "From Bram", authorId: "user_bram" });
    await store(b, "user_bram").reply({ threadId: id, body: "Bram again", authorId: "user_bram" });
    sync(a, b);
    expect(readThreads(a)).toEqual(readThreads(b));
    expect(readThreads(a)[0].comments.map((comment) => commentText(comment.content)).sort())
      .toEqual(["Bram again", "From Ada", "From Bram", "Opening"]);
    expect(commentText(readThreads(a)[0].comments[0].content)).toBe("Opening");
    const bramFirst = readThreads(a)[0].comments.findIndex((comment) => commentText(comment.content) === "From Bram");
    const bramSecond = readThreads(a)[0].comments.findIndex((comment) => commentText(comment.content) === "Bram again");
    expect(bramFirst).toBeLessThan(bramSecond);
    expectValid(a);
  });

  it("concurrent new threads converge to one order", async () => {
    const a = fresh();
    const b = replica(a);
    await store(a).createThread({ anchor: ANCHOR, body: "A", authorId: "user_ada" });
    await store(b, "user_bram").createThread({ anchor: ANCHOR, body: "B", authorId: "user_bram" });
    sync(a, b);
    expect(readThreads(a).map((thread) => thread.id)).toEqual(readThreads(b).map((thread) => thread.id));
    expect(readThreads(a)).toHaveLength(2);
  });

  it("concurrent resolves agree on one resolver and one time", async () => {
    const a = fresh();
    const id = await store(a).createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    const b = replica(a);
    await store(a).resolve({ threadId: id, by: "user_ada", at: 10 });
    await store(b, "user_bram").resolve({ threadId: id, by: "user_bram", at: 20 });
    sync(a, b);
    const [thread] = readThreads(a);
    expect(readThreads(b)).toEqual(readThreads(a));
    expect([["user_ada", 10], ["user_bram", 20]]).toContainEqual([thread.resolvedBy, thread.resolvedAt]);
    expectValid(a);
  });

  it("a resolve racing a reopen converges, and the document stays writable", async () => {
    for (const [clientA, clientB] of [[1, 2], [2, 1]]) {
      const base = fresh();
      const id = await store(base).createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada", threadId: "t1" });
      await store(base).resolve({ threadId: id, by: "user_ada" });
      const a = replica(base, clientA);
      const b = replica(base, clientB);
      await store(a).reopen({ threadId: id });
      await store(b, "user_bram").reopen({ threadId: id });
      await store(b, "user_bram").resolve({ threadId: id, by: "user_bram", at: 50 });
      sync(a, b);
      expect(readThreads(a)).toEqual(readThreads(b));
      // Whatever the merge made, every next write from either side lands and
      // leaves its own replica whole — even while the two go on racing.
      for (let round = 0; round < 3; round++) {
        await store(a).reply({ threadId: id, body: `Carry on ${round}`, authorId: "user_ada" });
        expectValid(a);
        await store(b, "user_bram").reopen({ threadId: id });
        await store(b, "user_bram").resolve({ threadId: id, by: "user_bram" });
        expectValid(b);
        sync(a, b);
        expect(readThreads(a)).toEqual(readThreads(b));
      }
      expect(readThreads(a)[0].comments).toHaveLength(4);
    }
  });

  it("a merge that pairs one side's status with the other's stamps is repaired on the next write, as a system write", async () => {
    // Reopen on A while B reopens and resolves again: with A ordered after B,
    // A's `open` wins the status while B's stamps survive — a thread the
    // validator refuses, which would refuse every later write.
    const base = fresh();
    await store(base).createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada", threadId: "t1" });
    await store(base).resolve({ threadId: "t1", by: "user_ada" });
    const a = replica(base, 2);
    const b = replica(base, 1);
    await store(a).reopen({ threadId: "t1" });
    await store(b, "user_bram").reopen({ threadId: "t1" });
    await store(b, "user_bram").resolve({ threadId: "t1", by: "user_bram", at: 50 });
    sync(a, b);
    expect(validateDocument(decodeNmlDocument(a)).map((issue) => issue.code)).toEqual(["thread_resolution"]);
    expect(readThreads(a)[0]).toMatchObject({ status: "open", resolvedBy: "user_bram" });

    // Both replicas write before hearing each other's repair.
    const seenA = origins(a);
    const id = await store(a).createThread({ anchor: ANCHOR, body: "Still writable", authorId: "user_ada" });
    await store(b, "user_bram").reply({ threadId: "t1", body: "Me too", authorId: "user_bram" });
    expect(seenA.map((origin) => [origin.actor.kind, origin.command])).toEqual([
      ["system", "comments.repair"],
      ["human", "comments.create-thread"],
    ]);
    sync(a, b);
    expectValid(a);
    expect(readThreads(a)).toEqual(readThreads(b));
    expect(readThreads(a).map((thread) => thread.id)).toEqual(["t1", id]);
    expect(readThreads(a)[0]).toMatchObject({ status: "open" });
    expect(readThreads(a)[0]).not.toHaveProperty("resolvedBy");
  });

  it("repairs only ahead of a write: never for a no-op, a refusal, or under a review fork", async () => {
    const base = fresh();
    await store(base).createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada", threadId: "t1" });
    await store(base).resolve({ threadId: "t1", by: "user_ada" });
    const a = replica(base, 2);
    const b = replica(base, 1);
    await store(a).reopen({ threadId: "t1" });
    await store(b, "user_bram").reopen({ threadId: "t1" });
    await store(b, "user_bram").resolve({ threadId: "t1", by: "user_bram", at: 50 });
    sync(a, b);
    expect(validateDocument(decodeNmlDocument(a)).map((issue) => issue.code)).toEqual(["thread_resolution"]);
    const counter = updates(a);
    const commentId = readThreads(a)[0].comments[0].id;
    expect(await store(a).reopen({ threadId: "t1" })).toBe(false);
    await expect(store(a, "user_bram").editComment({ commentId, body: "Not mine", editorId: "user_bram" })).rejects.toMatchObject({ code: "not_author" });
    await expect(store(a).applyAnchorWrite("t1", { anchor: { blockId: "p_fork" } }, { forked: true })).rejects.toMatchObject({ code: "forked" });
    expect(await store(a).applyAnchorWrite("t1", { anchor: { ...ANCHOR } }, { forked: true })).toBe(false);
    expect(counter.count).toBe(0);
    expect(await store(a).applyAnchorWrite("t1", { anchor: { blockId: "p_real" } })).toBe(true);
    expect(counter.count).toBe(2);
    expectValid(a);
  });

  it("a thread a collaborator's undo removes while authorize is thinking is nothing to maintain", async () => {
    const doc = fresh();
    const peer = replica(doc);
    const history = new CommentsHistory(peer, { localUserId: "user_bram" });
    const id = await store(peer, "user_bram").createThread({ anchor: ANCHOR, body: "Oops", authorId: "user_bram" });
    sync(doc, peer);
    history.undo();
    let asked = 0;
    const result = await applyAnchorWrite(doc, id, { anchor: { blockId: "p_2" } }, {
      userId: "user_ada",
      authorize: async () => {
        // An undo only deletes, so it moves no state vector.
        if (asked++ === 0) sync(doc, peer);
        return true;
      },
    });
    expect(result).toBe(false);
    expect(readThreads(doc)).toEqual([]);
  });

  it("two concurrent creations of one thread both resolve its id, and it is written once", async () => {
    const doc = fresh();
    const slow = new CommentsStore(doc, {
      actor: { userId: "user_ada", kind: "human" },
      authorize: async () => true,
    });
    const input = { anchor: ANCHOR, body: "Double submit", authorId: "user_ada", threadId: "t-double", commentId: "c-double" };
    expect(await Promise.all([slow.createThread(input), slow.createThread(input)])).toEqual(["t-double", "t-double"]);
    expect(readThreads(doc).map((thread) => [thread.id, thread.comments.length])).toEqual([["t-double", 1]]);
  });

  it("a reply racing its thread's deletion goes with the thread, and both replicas keep writing", async () => {
    const a = fresh();
    const id = await store(a).createThread({ anchor: ANCHOR, body: "Opening", authorId: "user_ada" });
    const b = replica(a);
    await store(a).deleteThread({ threadId: id });
    await store(b, "user_bram").reply({ threadId: id, body: "Wait —", authorId: "user_bram" });
    sync(a, b);
    expect(readThreads(a)).toEqual([]);
    expect(readThreads(b)).toEqual([]);
    expectValid(a);
    expectValid(b);
    await expect(store(b, "user_bram").reply({ threadId: id, body: "Again", authorId: "user_bram" })).rejects.toMatchObject({ code: "missing" });
    await store(b, "user_bram").createThread({ anchor: ANCHOR, body: "Fresh start", authorId: "user_bram" });
    sync(a, b);
    expect(summary(readThreads(a))).toEqual(summary(readThreads(b)));
    expect(readThreads(a)).toHaveLength(1);
  });

  it("an edit racing the comment's deletion leaves the comment deleted", async () => {
    const a = fresh();
    const id = await store(a).createThread({ anchor: ANCHOR, body: "Opening", authorId: "user_ada" });
    const reply = await store(a, "user_bram").reply({ threadId: id, body: "Draft", authorId: "user_bram" });
    const b = replica(a);
    await store(a, "user_bram").deleteComment({ commentId: reply, by: "user_bram" });
    await store(b, "user_bram").editComment({ commentId: reply, body: "Final", editorId: "user_bram" });
    sync(a, b);
    expect(readThreads(a)).toEqual(readThreads(b));
    expect(readThreads(a)[0].comments.map((comment) => comment.id)).not.toContain(reply);
    expectValid(a);
  });
});
