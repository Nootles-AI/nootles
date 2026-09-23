import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { validateDocument } from "@/app/lib/nml/validate";
import { createNmlYDoc, decodeNmlDocument } from "@/app/lib/nml/yjs";
import { CommentsHistory, commentsHistoryFor } from "./history";
import { CommentsStore, readThreads } from "./store";
import { commentText, emptyCommentsDocument, type CommentAnchor } from "./types";

const ANCHOR: CommentAnchor = { blockId: "p1", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 8 };

let minted = 0;
function store(doc: Y.Doc, userId = "user_ada", kind: "human" | "model" = "human") {
  return new CommentsStore(doc, {
    actor: { userId, kind },
    authorize: () => true,
    createId: () => `id-${++minted}`,
  });
}

function setup() {
  const doc = createNmlYDoc(emptyCommentsDocument("comments-doc"));
  const history = new CommentsHistory(doc, { localUserId: "user_ada" });
  return { doc, history, ada: store(doc) };
}

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), "remote");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "remote");
}

const texts = (doc: Y.Doc) => readThreads(doc).map((thread) => thread.comments.map((comment) => commentText(comment.content)));

describe("CommentsHistory", () => {
  it("undoes and redoes starting a thread", async () => {
    const { doc, history, ada } = setup();
    await ada.createThread({ anchor: ANCHOR, body: "Hello", authorId: "user_ada" });
    expect(history.canUndo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(readThreads(doc)).toEqual([]);
    expect(history.canRedo()).toBe(true);
    expect(history.redo()).toBe(true);
    expect(texts(doc)).toEqual([["Hello"]]);
    expect(validateDocument(decodeNmlDocument(doc))).toEqual([]);
  });

  it("makes every action its own step, however quickly they follow", async () => {
    const { doc, history, ada } = setup();
    const id = await ada.createThread({ anchor: ANCHOR, body: "One", authorId: "user_ada" });
    await ada.reply({ threadId: id, body: "Two", authorId: "user_ada" });
    await ada.reply({ threadId: id, body: "Three", authorId: "user_ada" });
    history.undo();
    expect(texts(doc)).toEqual([["One", "Two"]]);
    history.undo();
    expect(texts(doc)).toEqual([["One"]]);
    history.undo();
    expect(texts(doc)).toEqual([]);
    expect(history.undo()).toBe(false);
  });

  it("undoes an edit, a resolve and a delete", async () => {
    const { doc, history, ada } = setup();
    const id = await ada.createThread({ anchor: ANCHOR, body: "Draft", authorId: "user_ada" });
    const commentId = readThreads(doc)[0].comments[0].id;
    await ada.editComment({ commentId, body: "Final", editorId: "user_ada" });
    await ada.resolve({ threadId: id, by: "user_ada" });
    await ada.deleteThread({ threadId: id });
    history.undo();
    expect(readThreads(doc)[0]).toMatchObject({ status: "resolved", resolvedBy: "user_ada" });
    history.undo();
    expect(readThreads(doc)[0].status).toBe("open");
    expect(readThreads(doc)[0]).not.toHaveProperty("resolvedBy");
    history.undo();
    expect(texts(doc)).toEqual([["Draft"]]);
    expect(readThreads(doc)[0].comments[0]).not.toHaveProperty("editedAt");
    expect(validateDocument(decodeNmlDocument(doc))).toEqual([]);
  });

  it("never takes back a collaborator's work", async () => {
    const { doc, history, ada } = setup();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const mine = await ada.createThread({ anchor: ANCHOR, body: "Mine", authorId: "user_ada" });
    const theirs = await store(peer, "user_bram").createThread({ anchor: ANCHOR, body: "Theirs", authorId: "user_bram" });
    sync(doc, peer);
    await store(peer, "user_bram").reply({ threadId: theirs, body: "More of theirs", authorId: "user_bram" });
    sync(doc, peer);
    expect(history.undo()).toBe(true);
    expect(readThreads(doc).map((thread) => thread.id)).toEqual([theirs]);
    expect(texts(doc)).toEqual([["Theirs", "More of theirs"]]);
    expect(history.canUndo()).toBe(false);
    sync(doc, peer);
    expect(readThreads(peer).map((thread) => thread.id)).not.toContain(mine);
  });

  it("steps over the assistant's writes and another local user's", async () => {
    const { doc, history, ada } = setup();
    await store(doc, "user_ada", "model").createThread({ anchor: ANCHOR, body: "From the assistant", authorId: "user_ada" });
    await store(doc, "user_other").createThread({ anchor: ANCHOR, body: "Someone else here", authorId: "user_other" });
    expect(history.canUndo()).toBe(false);
    await ada.createThread({ anchor: ANCHOR, body: "Mine", authorId: "user_ada" });
    history.undo();
    expect(texts(doc)).toEqual([["From the assistant"], ["Someone else here"]]);
    expect(history.canUndo()).toBe(false);
  });

  it("never undoes anchor maintenance: undoing a resolve leaves a re-home in place", async () => {
    const { doc, history, ada } = setup();
    const id = await ada.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    await ada.resolve({ threadId: id, by: "user_ada" });
    await ada.applyAnchorWrite(id, { anchor: { blockId: "p_moved", exact: "by Thursday" }, ambiguous: true, orphanedAt: 7 });
    await ada.applyAnchorWrite(id, { orphanedAt: null });
    history.undo();
    const [thread] = readThreads(doc);
    expect(thread.status).toBe("open");
    expect(thread.anchor).toEqual({ ...ANCHOR, blockId: "p_moved", exact: "by Thursday" });
    expect(thread.ambiguous).toBe(true);
    expect(thread).not.toHaveProperty("orphanedAt");
    // The next step back is the thread's creation, not the maintenance.
    history.redo();
    expect(readThreads(doc)[0].status).toBe("resolved");
    history.undo();
    history.undo();
    expect(readThreads(doc)).toEqual([]);
    expect(history.canUndo()).toBe(false);
  });

  it("a remote update between two of mine leaves both undoable in order", async () => {
    const { doc, history, ada } = setup();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const id = await ada.createThread({ anchor: ANCHOR, body: "One", authorId: "user_ada" });
    sync(doc, peer);
    await store(peer, "user_bram").reply({ threadId: id, body: "Theirs", authorId: "user_bram" });
    sync(doc, peer);
    await ada.reply({ threadId: id, body: "Two", authorId: "user_ada" });
    history.undo();
    expect(texts(doc)).toEqual([["One", "Theirs"]]);
  });

  it("reports canUndo/canRedo through one stable state object and a subscription", async () => {
    const { history, ada } = setup();
    const initial = history.getState();
    expect(initial).toEqual({ canUndo: false, canRedo: false });
    expect(history.getState()).toBe(initial);
    let heard = 0;
    const stop = history.subscribe(() => heard++);
    const id = await ada.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    expect(history.getState()).toEqual({ canUndo: true, canRedo: false });
    expect(heard).toBe(1);
    const afterCreate = history.getState();
    await ada.reply({ threadId: id, body: "More", authorId: "user_ada" });
    expect(heard).toBe(1);
    expect(history.getState()).toBe(afterCreate);
    history.undo();
    history.undo();
    expect(history.getState()).toEqual({ canUndo: false, canRedo: true });
    history.clear();
    expect(history.getState()).toEqual({ canUndo: false, canRedo: false });
    const beforeStop = heard;
    stop();
    await ada.createThread({ anchor: ANCHOR, body: "Again", authorId: "user_ada" });
    expect(heard).toBe(beforeStop);
  });

  it("is one per document and person", async () => {
    const doc = createNmlYDoc(emptyCommentsDocument("comments-doc"));
    const ada = commentsHistoryFor(doc, { localUserId: "user_ada" });
    expect(commentsHistoryFor(doc, { localUserId: "user_ada" })).toBe(ada);
    expect(commentsHistoryFor(createNmlYDoc(emptyCommentsDocument("other")), { localUserId: "user_ada" })).not.toBe(ada);

    // Someone else signing in on the same warm doc gets a timeline of their own.
    await store(doc).createThread({ anchor: ANCHOR, body: "Ada's", authorId: "user_ada" });
    const bram = commentsHistoryFor(doc, { localUserId: "user_bram" });
    expect(bram).not.toBe(ada);
    expect(bram.canUndo()).toBe(false);
    await store(doc, "user_bram").createThread({ anchor: ANCHOR, body: "Bram's", authorId: "user_bram" });
    bram.undo();
    expect(texts(doc)).toEqual([["Ada's"]]);
  });

  it("a destroyed history is replaced, not handed out again", async () => {
    const doc = createNmlYDoc(emptyCommentsDocument("comments-doc"));
    const first = commentsHistoryFor(doc, { localUserId: "user_ada" });
    first.destroy();
    const second = commentsHistoryFor(doc, { localUserId: "user_ada" });
    expect(second).not.toBe(first);
    await store(doc).createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    expect(second.canUndo()).toBe(true);
  });

  it("stops tracking once destroyed", async () => {
    const { history, ada } = setup();
    history.destroy();
    await ada.createThread({ anchor: ANCHOR, body: "Hi", authorId: "user_ada" });
    expect(history.canUndo()).toBe(false);
  });
});
