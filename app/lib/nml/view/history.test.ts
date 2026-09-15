import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { createNmlYDoc, decodeNmlDocument, type NmlTransactionOrigin } from "../yjs";
import { executeNmlCommands, type NmlCommand } from "../commands";
import { NmlHistory, NmlReviewHistory, checkpointBlock, nmlCheckpoint, nmlHistoryFor, nmlReviewHistoryFor } from "./history";

const authorize = () => true;

function doc() {
  return createNmlYDoc({
    schemaVersion: 1,
    documentId: "d",
    blocks: [{ id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "hello", marks: [] }], children: [] }],
  });
}

function paragraphText(d: Y.Doc): string {
  const block = decodeNmlDocument(d).blocks[0];
  return "content" in block ? block.content.map((n) => (n.type === "text" ? n.text : "")).join("") : "";
}

let seq = 0;
function origin(kind: "human" | "model" | "system", command: string, userId = "u1"): NmlTransactionOrigin {
  seq += 1;
  return { version: 1, transactionId: `t${seq}`, actor: { userId, kind }, command };
}

async function insert(d: Y.Doc, at: number, text: string, o: NmlTransactionOrigin) {
  const commands: NmlCommand[] = [{ type: "replaceInline", nodeId: "p1", range: { from: at, to: at }, content: [{ type: "text", text, marks: [] }] }];
  await executeNmlCommands({ doc: d, documentId: "d", commands, origin: o, idempotencyKey: o.transactionId, authorize });
}

function twoBlockDoc() {
  return createNmlYDoc({
    schemaVersion: 1,
    documentId: "d",
    blocks: [
      { id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "one", marks: [] }], children: [] },
      { id: "p2", type: "paragraph", props: {}, content: [{ type: "text", text: "two", marks: [] }], children: [] },
    ],
  });
}

async function run(d: Y.Doc, commands: NmlCommand[], o: NmlTransactionOrigin) {
  await executeNmlCommands({ doc: d, documentId: "d", commands, origin: o, idempotencyKey: o.transactionId, authorize });
}

function blockIds(d: Y.Doc): string[] {
  return decodeNmlDocument(d).blocks.map((b) => b.id);
}

describe("NmlHistory — canonical undo", () => {
  it("tracks a local human edit, undoes it, and redoes it", async () => {
    const d = doc();
    const history = new NmlHistory(d, { localUserId: "u1" });
    await insert(d, 0, "X", origin("human", "plain-text-edit"));
    expect(paragraphText(d)).toBe("Xhello");
    expect(history.canUndo()).toBe(true);

    expect(history.undo()).toBe(true);
    expect(paragraphText(d)).toBe("hello");
    expect(history.canRedo()).toBe(true);

    expect(history.redo()).toBe(true);
    expect(paragraphText(d)).toBe("Xhello");
    history.destroy();
    d.destroy();
  });

  it("leaves model and system batches view-only (not linearly undoable)", async () => {
    const d = doc();
    const history = new NmlHistory(d, { localUserId: "u1" });
    await insert(d, 0, "M", origin("model", "domain-edit"));
    await insert(d, 0, "S", origin("system", "domain-edit"));
    expect(paragraphText(d)).toBe("SMhello");
    // Neither is the local human's, so ⌘Z has nothing of theirs to take back.
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBe(false);
    expect(paragraphText(d)).toBe("SMhello");
    history.destroy();
    d.destroy();
  });

  it("does not track another human's edits when scoped to a local user", async () => {
    const d = doc();
    const history = new NmlHistory(d, { localUserId: "u1" });
    await insert(d, 0, "O", origin("human", "plain-text-edit", "other-user"));
    expect(history.canUndo()).toBe(false);
    history.destroy();
    d.destroy();
  });

  it("coalesces consecutive typing into one undo step, but keeps structure discrete", async () => {
    const typing = doc();
    const h1 = new NmlHistory(typing, { localUserId: "u1" });
    await insert(typing, 0, "A", origin("human", "plain-text-edit"));
    await insert(typing, 0, "B", origin("human", "plain-text-edit"));
    expect(paragraphText(typing)).toBe("BAhello");
    expect(h1.manager.undoStack.length).toBe(1); // one typing burst
    h1.undo();
    expect(paragraphText(typing)).toBe("hello"); // whole burst gone at once
    h1.destroy();
    typing.destroy();

    const mixed = doc();
    const h2 = new NmlHistory(mixed, { localUserId: "u1" });
    await insert(mixed, 0, "A", origin("human", "plain-text-edit"));
    await insert(mixed, 0, "B", origin("human", "domain-edit")); // different command → discrete
    expect(h2.manager.undoStack.length).toBe(2);
    h2.destroy();
    mixed.destroy();
  });

  it("breakGroup forces the next typing edit into a separate undo step", async () => {
    const d = doc();
    const history = new NmlHistory(d, { localUserId: "u1" });
    await insert(d, 0, "A", origin("human", "plain-text-edit"));
    history.breakGroup();
    await insert(d, 0, "B", origin("human", "plain-text-edit"));
    expect(history.manager.undoStack.length).toBe(2);
    history.destroy();
    d.destroy();
  });

  it("preserves an unrelated collaborator's concurrent edit when undoing (the gate)", async () => {
    // A and B share the same initial state so their concurrent inserts merge.
    const a = doc();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const historyA = new NmlHistory(a, { localUserId: "A" });

    // A inserts "A" at the start; B inserts "B" at the end — concurrently.
    await insert(a, 0, "A", origin("human", "plain-text-edit", "A"));
    await insert(b, 5, "B", origin("human", "plain-text-edit", "B"));

    // Cross-sync as a provider would: remote updates carry a non-NML origin, so
    // neither manager tracks the other's edit.
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    expect(paragraphText(a)).toBe("AhelloB");

    // A undoes only A's own edit; B's concurrent insert survives.
    expect(historyA.undo()).toBe(true);
    expect(paragraphText(a)).toBe("helloB");
    historyA.destroy();
    a.destroy();
    b.destroy();
  });

  it("shares one history per Y.Doc (survives a bridge remount)", () => {
    const d = doc();
    const first = nmlHistoryFor(d, { localUserId: "u1" });
    const second = nmlHistoryFor(d);
    expect(second).toBe(first);
    first.destroy();
    d.destroy();
  });
});

describe("NmlReviewHistory — rewind of model/system batches", () => {
  it("rewinds a model batch as one unit and re-applies it", async () => {
    const d = twoBlockDoc();
    const review = new NmlReviewHistory(d);
    await run(d, [{ type: "removeNodes", nodeIds: ["p2"] }], origin("model", "domain-edit", "ai"));
    expect(blockIds(d)).toEqual(["p1"]);
    expect(review.canRewind()).toBe(true);

    expect(review.rewind()).toBe(true);
    expect(blockIds(d)).toEqual(["p1", "p2"]); // deleted block restored via CRDT
    expect(review.canReapply()).toBe(true);

    expect(review.reapply()).toBe(true);
    expect(blockIds(d)).toEqual(["p1"]);
    review.destroy();
    d.destroy();
  });

  it("does not track human edits (kept off the review log)", async () => {
    const d = doc();
    const review = new NmlReviewHistory(d);
    await insert(d, 0, "X", origin("human", "plain-text-edit"));
    expect(review.canRewind()).toBe(false);
    review.destroy();
    d.destroy();
  });

  it("restores a batch's deletion while preserving a concurrent human edit (the gate)", async () => {
    const ai = twoBlockDoc();
    const human = new Y.Doc();
    Y.applyUpdate(human, Y.encodeStateAsUpdate(ai));
    const review = new NmlReviewHistory(ai);

    // AI removes p2; a human concurrently edits p1's text.
    await run(ai, [{ type: "removeNodes", nodeIds: ["p2"] }], origin("model", "domain-edit", "ai"));
    await run(human, [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "EDIT-", marks: [] }] }], origin("human", "plain-text-edit", "u1"));
    Y.applyUpdate(ai, Y.encodeStateAsUpdate(human), "remote");
    Y.applyUpdate(human, Y.encodeStateAsUpdate(ai), "remote");
    expect(blockIds(ai)).toEqual(["p1"]);

    review.rewind();
    expect(blockIds(ai)).toEqual(["p1", "p2"]); // batch deletion undone
    const p1 = decodeNmlDocument(ai).blocks.find((b) => b.id === "p1");
    const p1Text = p1 && "content" in p1 ? p1.content.map((n) => (n.type === "text" ? n.text : "")).join("") : "";
    expect(p1Text).toBe("EDIT-one"); // concurrent human edit preserved
    review.destroy();
    ai.destroy();
    human.destroy();
  });

  it("captures a checkpoint and reads a node's content-free block for recovery", () => {
    const d = twoBlockDoc();
    const checkpoint = nmlCheckpoint(d);
    expect(checkpointBlock(checkpoint, "p2")?.type).toBe("paragraph");
    expect(checkpointBlock(checkpoint, "missing")).toBeNull();
    expect(nmlReviewHistoryFor(d)).toBe(nmlReviewHistoryFor(d));
    d.destroy();
  });
});
