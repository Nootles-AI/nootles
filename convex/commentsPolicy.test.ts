/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { joinUpdateRows } from "./yshape";
import { inlineLength } from "@/app/lib/nml/commands";
import { NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY } from "@/app/lib/nml/yjs";
import { COMMENTS_REFUSED, refuseCommentsUpdate } from "@/app/lib/comments/policy";
import { CommentsHistory } from "@/app/lib/comments/history";
import { CommentsStore, readThreads } from "@/app/lib/comments/store";
import { bytes, comment, run, startThread, thread, updateOf } from "@/app/lib/comments/updates.fixture";

/**
 * What a comments append may change (`comments/policy.ts`), judged by
 * `ydoc.append` against the document as stored. Every forgery here is built
 * the way a hostile client would build it — raw NML commands or raw Yjs on a
 * replica of the server's state, with no store asking who wrote what — and
 * sent as a real identity.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const EDITOR = { subject: "user_editor" };
const CORA = { subject: "user_cora" };
const DAN = { subject: "user_dan" };

type T = TestConvex<typeof schema>;
type Who = { subject: string };

function harness(): T {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

type World = { t: T; pageId: Id<"pages">; docId: string };

/** An owner's page with its comments document; an editor and two commenters (Cora, Dan) on live links. */
async function world(): Promise<World> {
  const t = harness();
  const pageId = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "P",
      createdAt: 1,
      updatedAt: 1,
      editShareToken: "edit-tok",
      commentShareToken: "comment-tok",
    });
    const pageId = await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId,
      title: "Plan",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("shareClaims", { projectId, granteeId: EDITOR.subject, role: "editor", createdAt: 1 });
    for (const who of [CORA, DAN]) {
      await ctx.db.insert("shareClaims", { projectId, granteeId: who.subject, role: "commenter", createdAt: 1 });
    }
    return pageId;
  });
  const docId = await t.withIdentity(OWNER).mutation(api.comments.ensureDoc, { pageId });
  return { t, pageId, docId };
}

/** A replica of everything the server holds for the document. */
async function replica({ t, docId }: World): Promise<Y.Doc> {
  const loaded = await t.withIdentity(OWNER).query(api.ydoc.load, { docId, afterSeq: 0 });
  const doc = new Y.Doc();
  for (const row of joinUpdateRows(loaded!.updates)) Y.applyUpdate(doc, row.update);
  return doc;
}

const append = (w: World, who: Who, update: ArrayBuffer) =>
  w.t.withIdentity(who).mutation(api.ydoc.append, { docId: w.docId, update });

const seq = async (w: World) => (await w.t.withIdentity(OWNER).query(api.ydoc.meta, { docId: w.docId }))!.seq;

/** Refused as a comments refusal, with nothing landed. */
async function refused(w: World, who: Who, update: ArrayBuffer, message?: RegExp) {
  const before = await seq(w);
  const error = await append(w, who, update).then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConvexError);
  const data = (error as ConvexError<{ code: string; message: string }>).data;
  expect(data.code).toBe(COMMENTS_REFUSED);
  if (message) expect(data.message).toMatch(message);
  expect(await seq(w)).toBe(before);
}

/** A thread by `author` with one reply by `replier`, landed; returns a fresh replica. */
async function discussed(w: World, author: Who, replier: Who): Promise<Y.Doc> {
  const doc = await replica(w);
  await append(w, author, await startThread(doc, author.subject, "t1"));
  await append(
    w,
    replier,
    await updateOf(doc, () =>
      run(doc, replier.subject, [{ type: "insertNodes", parentId: "t1", nodes: [comment("r1", replier.subject, "A reply")] }]),
    ),
  );
  return replica(w);
}

const remove = (doc: Y.Doc, who: Who, id: string) =>
  updateOf(doc, () => run(doc, who.subject, [{ type: "removeNodes", nodeIds: [id] }]));

const setProps = (doc: Y.Doc, who: Who, id: string, patch: Record<string, unknown>) =>
  updateOf(doc, () => run(doc, who.subject, [{ type: "setNodeProps", nodeId: id, patch }]));

function reword(doc: Y.Doc, who: Who, id: string, text: string) {
  const current = readThreads(doc).flatMap((t) => t.comments).find((c) => c.id === id)!;
  return updateOf(doc, () =>
    run(doc, who.subject, [
      { type: "replaceInline", nodeId: id, range: { from: 0, to: inlineLength(current.content) }, content: [{ type: "text", text, marks: [] }] },
    ]),
  );
}

/** One of the structure's maps, for raw writes the executor would refuse. */
function structure(doc: Y.Doc, key: "placements" | "registry"): Y.Map<Y.Map<unknown>> {
  return (doc.getMap(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY) as Y.Map<Y.Map<Y.Map<unknown>>>).get(key)!;
}

describe("authorship", () => {
  test("a comment signed with someone else's name is refused — a new thread or a reply", async () => {
    const w = await world();
    const doc = await replica(w);
    await refused(w, CORA, await startThread(doc, CORA.subject, "t1", EDITOR.subject), /your own name/);

    const fresh = await discussed(w, EDITOR, EDITOR);
    await refused(
      w,
      CORA,
      await updateOf(fresh, () =>
        run(fresh, CORA.subject, [{ type: "insertNodes", parentId: "t1", nodes: [comment("r2", OWNER.subject)] }]),
      ),
    );
  });

  test("the assistant writes as the signed-in person, marked, and is accepted", async () => {
    const w = await world();
    const doc = await replica(w);
    const update = await updateOf(doc, () =>
      run(doc, CORA.subject, [
        { type: "insertNodes", parentId: null, nodes: [thread("t1", [comment("c1", CORA.subject, "From the assistant", { via: "assistant" })])] },
      ]),
    );
    await expect(append(w, CORA, update)).resolves.toBe(2);
  });

  test("nobody rewrites another person's comment — not a commenter, not the owner", async () => {
    const w = await world();
    const doc = await discussed(w, CORA, DAN);
    await refused(w, CORA, await reword(doc, CORA, "r1", "Dan never said this"), /author/);
    const again = await replica(w);
    await refused(w, OWNER, await reword(again, OWNER, "t1-c1", "Nor this"), /author/);
    const stamps = await replica(w);
    await refused(w, OWNER, await setProps(stamps, OWNER, "r1", { createdAt: 1 }), /author/);
    const via = await replica(w);
    await refused(w, CORA, await setProps(via, CORA, "r1", { via: "assistant" }), /author/);
    // Their author may.
    const own = await replica(w);
    await expect(append(w, DAN, await reword(own, DAN, "r1", "Reworded"))).resolves.toBe(4);
  });

  test("an author cannot hand their comment to someone else", async () => {
    const w = await world();
    const doc = await discussed(w, CORA, CORA);
    await refused(w, CORA, await setProps(doc, CORA, "r1", { authorId: DAN.subject }));
  });

  test("a comment cannot be moved into another thread by anyone but its author", async () => {
    const w = await world();
    const doc = await discussed(w, CORA, DAN);
    await append(w, CORA, await startThread(doc, CORA.subject, "t2"));
    const moved = await replica(w);
    await refused(
      w,
      CORA,
      await updateOf(moved, () =>
        run(moved, CORA.subject, [{ type: "moveNodes", nodeIds: ["r1"], destination: { parentId: "t2" } }]),
      ),
    );
  });
});

describe("deletion", () => {
  test("another person's reply: refused to a commenter, allowed to the owner and an editor", async () => {
    for (const [who, allowed] of [[DAN, false], [OWNER, true], [EDITOR, true]] as const) {
      const w = await world();
      const doc = await discussed(w, CORA, CORA);
      const update = await remove(doc, who, "r1");
      if (allowed) await expect(append(w, who, update)).resolves.toBe(4);
      else await refused(w, who, update, /delete/);
    }
  });

  test("another person's thread: refused to a commenter, allowed to the owner and an editor", async () => {
    for (const [who, allowed] of [[DAN, false], [OWNER, true], [EDITOR, true]] as const) {
      const w = await world();
      const doc = await discussed(w, CORA, CORA);
      const update = await remove(doc, who, "t1");
      if (allowed) await expect(append(w, who, update)).resolves.toBe(4);
      else await refused(w, who, update, /thread/);
    }
  });

  test("a thread's author deletes it with everyone's replies; a reply's author deletes the reply", async () => {
    const w = await world();
    const doc = await discussed(w, CORA, DAN);
    await expect(append(w, DAN, await remove(doc, DAN, "r1"))).resolves.toBe(4);
    await expect(append(w, CORA, await remove(await discussedAgain(w, DAN), CORA, "t1"))).resolves.toBe(6);
  });

  test("the opening comment cannot be removed from under its thread, nor replaced", async () => {
    const w = await world();
    const doc = await discussed(w, CORA, DAN);
    await refused(w, CORA, await remove(doc, CORA, "t1-c1"), /opening/);
  });
});

describe("undoing a deletion", () => {
  /** `who`'s deletion of `id` through the store's own history, then its undo — each as the update the provider would send. */
  async function deleteThenUndo(w: World, who: Who, id: string) {
    const doc = await replica(w);
    const history = new CommentsHistory(doc, { localUserId: who.subject });
    const store = new CommentsStore(doc, { actor: { userId: who.subject, kind: "human" }, authorize: () => true });
    const removal = await updateOf(doc, () => store.deleteThread({ threadId: id }));
    const undo = await updateOf(doc, () => history.undo());
    return { removal, undo };
  }

  test("the owner puts back a thread of someone else's they deleted, replies and all", async () => {
    const w = await world();
    await discussed(w, CORA, DAN);
    const { removal, undo } = await deleteThenUndo(w, OWNER, "t1");
    await expect(append(w, OWNER, removal)).resolves.toBe(4);
    await expect(append(w, OWNER, undo)).resolves.toBe(5);
    expect(readThreads(await replica(w)).map((t) => t.comments.map((c) => c.authorId))).toEqual([[CORA.subject, DAN.subject]]);
  });

  test("a thread's author puts back her thread with someone else's reply in it", async () => {
    const w = await world();
    await discussed(w, CORA, DAN);
    const { removal, undo } = await deleteThenUndo(w, CORA, "t1");
    await expect(append(w, CORA, removal)).resolves.toBe(4);
    await expect(append(w, CORA, undo)).resolves.toBe(5);
  });

  test("a commenter cannot bring back what an owner deleted, nor bring it back changed", async () => {
    const w = await world();
    await discussed(w, CORA, DAN);
    const { removal } = await deleteThenUndo(w, OWNER, "t1");
    await append(w, OWNER, removal);
    const doc = await replica(w);
    const deletions = () => (doc.getMap(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY) as Y.Map<Y.Map<boolean>>).get("deletions")!;
    await refused(w, DAN, await updateOf(doc, () => deletions().delete("t1")), /your own name/);
    const changed = await replica(w);
    const undeleted = await updateOf(changed, () => {
      changed.transact(() => {
        (changed.getMap(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY) as Y.Map<Y.Map<boolean>>).get("deletions")!.delete("t1");
        (structure(changed, "registry").get("r1")!.get("props") as Y.Map<unknown>).set("createdAt", 1);
      });
    });
    await refused(w, OWNER, undeleted, /your own name/);

    // Nor by re-signing the opening comment to make the thread look like his.
    const resigned = await replica(w);
    const update = await updateOf(resigned, () => {
      resigned.transact(() => {
        const flags = (resigned.getMap(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY) as Y.Map<Y.Map<boolean>>).get("deletions")!;
        for (const id of ["t1", "t1-c1", "r1"]) flags.delete(id);
        (structure(resigned, "registry").get("t1-c1")!.get("props") as Y.Map<unknown>).set("authorId", DAN.subject);
      });
    });
    await refused(w, DAN, update, /your own name/);
  });

  test("undoing a reopen, or a reply that reopened, puts back someone else's resolution", async () => {
    const w = await world();
    const base = await discussed(w, EDITOR, EDITOR);
    await append(w, DAN, await setProps(base, DAN, "t1", { status: "resolved", resolvedBy: DAN.subject, resolvedAt: 5 }));
    const doc = await replica(w);
    const history = new CommentsHistory(doc, { localUserId: CORA.subject });
    const store = new CommentsStore(doc, { actor: { userId: CORA.subject, kind: "human" }, authorize: () => true });
    await expect(append(w, CORA, await updateOf(doc, () => store.reopen({ threadId: "t1" })))).resolves.toBe(5);
    await expect(append(w, CORA, await updateOf(doc, () => history.undo()))).resolves.toBe(6);
    expect(readThreads(await replica(w))[0]).toMatchObject({ status: "resolved", resolvedBy: DAN.subject });

    const reply = await updateOf(doc, () => store.reply({ threadId: "t1", body: "Reopening", authorId: CORA.subject }));
    await expect(append(w, CORA, reply)).resolves.toBe(7);
    await expect(append(w, CORA, await updateOf(doc, () => history.undo()))).resolves.toBe(8);
    const [thread] = readThreads(await replica(w));
    expect([thread.status, thread.resolvedBy, thread.comments.length]).toEqual(["resolved", DAN.subject, 2]);
  });
});

/** Dan replies again to t1, landed; returns a fresh replica. */
async function discussedAgain(w: World, replier: Who): Promise<Y.Doc> {
  const doc = await replica(w);
  await append(
    w,
    replier,
    await updateOf(doc, () =>
      run(doc, replier.subject, [{ type: "insertNodes", parentId: "t1", nodes: [comment("r3", replier.subject)] }]),
    ),
  );
  return replica(w);
}

describe("resolution and anchors", () => {
  test("resolving in someone else's name is refused; in your own, accepted; anyone reopens", async () => {
    const w = await world();
    const doc = await discussed(w, EDITOR, EDITOR);
    await refused(w, CORA, await setProps(doc, CORA, "t1", { status: "resolved", resolvedBy: EDITOR.subject, resolvedAt: 5 }), /resolved/);
    const nameless = await replica(w);
    // Nor in nobody's: a bare status, which validation alone would let through as a merge's leftovers.
    const status = structure(nameless, "registry").get("t1")!.get("props") as Y.Map<unknown>;
    await refused(w, CORA, await updateOf(nameless, () => status.set("status", "resolved")), /resolved/);
    const mine = await replica(w);
    await expect(
      append(w, CORA, await setProps(mine, CORA, "t1", { status: "resolved", resolvedBy: CORA.subject, resolvedAt: 5 })),
    ).resolves.toBe(4);
    const reopen = await replica(w);
    await expect(
      append(w, DAN, await setProps(reopen, DAN, "t1", { status: "open", resolvedBy: undefined, resolvedAt: undefined })),
    ).resolves.toBe(5);
  });

  test("anchor maintenance on someone else's thread is any commenter's to write", async () => {
    const w = await world();
    const doc = await discussed(w, EDITOR, EDITOR);
    const update = await setProps(doc, DAN, "t1", {
      anchor: { blockId: "p_2", exact: "moved", prefix: "", suffix: "", offsetHint: 3 },
      ambiguous: true,
      orphanedAt: 99,
    });
    await expect(append(w, DAN, update)).resolves.toBe(4);
  });

  test("a merge honest replicas make into a half-resolved thread lands, and the store's repair heals it", async () => {
    // store.test.ts's merge: A reopens while B reopens and resolves again.
    const w = await world();
    const base = await discussed(w, CORA, CORA);
    await append(w, CORA, await setProps(base, CORA, "t1", { status: "resolved", resolvedBy: CORA.subject, resolvedAt: 5 }));
    const a = await replica(w);
    a.clientID = 2;
    const b = await replica(w);
    b.clientID = 1;
    const reopen = { status: "open", resolvedBy: undefined, resolvedAt: undefined };
    const fromA = await setProps(a, CORA, "t1", reopen);
    const fromB = await updateOf(b, async () => {
      await run(b, DAN.subject, [{ type: "setNodeProps", nodeId: "t1", patch: reopen }]);
      await run(b, DAN.subject, [{ type: "setNodeProps", nodeId: "t1", patch: { status: "resolved", resolvedBy: DAN.subject, resolvedAt: 50 } }]);
    });
    await expect(append(w, DAN, fromB)).resolves.toBe(5);
    await expect(append(w, CORA, fromA)).resolves.toBe(6);

    const merged = await replica(w);
    expect(readThreads(merged)[0]).toMatchObject({ status: "open", resolvedBy: DAN.subject });
    const store = new CommentsStore(merged, { actor: { userId: CORA.subject, kind: "human" }, authorize: () => true });
    const healed = await updateOf(merged, () => store.reply({ threadId: "t1", body: "Still here", authorId: CORA.subject }));
    await expect(append(w, CORA, healed)).resolves.toBe(7);
    expect(readThreads(await replica(w))[0]).not.toHaveProperty("resolvedBy");
  });
});

describe("the document itself", () => {
  test("a root that will not decode is refused", async () => {
    const w = await world();
    const doc = await replica(w);
    await refused(w, OWNER, await updateOf(doc, () => doc.getMap(NML_YJS_ROOT).set("junk", 1)), /unreadable/);
    const kind = await replica(w);
    await refused(w, OWNER, await updateOf(kind, () => kind.getMap(NML_YJS_ROOT).set("kind", "page")), /unreadable/);
  });

  test("a root that decodes but no longer validates is refused", async () => {
    const w = await world();
    const doc = await discussed(w, CORA, CORA);
    // Her own reply, lifted out of its thread to the top level: out of profile.
    await refused(w, CORA, await updateOf(doc, () => structure(doc, "placements").get("r1")!.set("parentId", null)), /invalid/);
  });

  test("any root but NML's and the receipts is refused", async () => {
    const w = await world();
    const doc = await replica(w);
    await refused(w, OWNER, await updateOf(doc, () => doc.getText("smuggled").insert(0, "x")), /nothing but comments/);
  });

  test("bytes that are not an update, and an update missing what it builds on, are refused", async () => {
    const w = await world();
    await refused(w, OWNER, bytes(new Uint8Array([9, 9, 9, 9])));
    const doc = await replica(w);
    await updateOf(doc, () => run(doc, CORA.subject, [{ type: "insertNodes", parentId: null, nodes: [thread("t1", [comment("c1", CORA.subject)])] }]));
    const next = await startThread(doc, CORA.subject, "t2");
    await refused(w, CORA, next, /depends/);
  });

  test("a chunked append is judged whole: forged in parts is refused, honest in parts lands", async () => {
    const w = await world();
    const split = (update: ArrayBuffer) => {
      const half = Math.floor(update.byteLength / 2);
      return [update.slice(0, half), update.slice(half)];
    };
    const doc = await replica(w);
    const forged = await startThread(doc, CORA.subject, "t1", EDITOR.subject);
    const before = await seq(w);
    await expect(
      w.t.withIdentity(CORA).mutation(api.ydoc.append, { docId: w.docId, chunks: split(forged) }),
    ).rejects.toThrow(/your own name/);
    expect(await seq(w)).toBe(before);
    const honest = await startThread(await replica(w), CORA.subject, "t2");
    await expect(
      w.t.withIdentity(CORA).mutation(api.ydoc.append, { docId: w.docId, chunks: split(honest) }),
    ).resolves.toBe(2);
    expect(readThreads(await replica(w)).map((t) => t.id)).toEqual(["t2"]);
  });

  test("the page's own document is never looked inside", async () => {
    const w = await world();
    const page = await w.t.run(async (ctx) => (await ctx.db.get(w.pageId))!.docId);
    const text = new Y.Doc();
    text.getText("anything").insert(0, "page words");
    await w.t.withIdentity(OWNER).mutation(api.ydoc.init, { docId: page, update: bytes(Y.encodeStateAsUpdate(text)) });
    const more = await updateOf(text, () => text.getText("anything").insert(0, "more "));
    await expect(w.t.withIdentity(EDITOR).mutation(api.ydoc.append, { docId: page, update: more })).resolves.toBe(2);
  });
});

describe("honest stores, end to end", () => {
  test("every store verb, as the people who may use it, lands", async () => {
    const w = await world();
    let minted = 0;
    const hands = (doc: Y.Doc, who: Who, kind: "human" | "model" = "human") =>
      new CommentsStore(doc, { actor: { userId: who.subject, kind }, authorize: () => true, createId: () => `id-${++minted}` });
    const step = async (who: Who, act: (doc: Y.Doc) => Promise<unknown>) => {
      const doc = await replica(w);
      await expect(append(w, who, await updateOf(doc, () => act(doc)))).resolves.toBeGreaterThan(1);
    };
    const anchor = { blockId: "p_1", exact: "page", prefix: "", suffix: "", offsetHint: 0 };

    await step(CORA, (d) => hands(d, CORA).createThread({ anchor, body: "Cora's", authorId: CORA.subject, threadId: "t1", commentId: "c1" }));
    await step(EDITOR, (d) => hands(d, EDITOR).reply({ threadId: "t1", body: "Editor's", authorId: EDITOR.subject, commentId: "r1" }));
    await step(DAN, (d) => hands(d, DAN).reply({ threadId: "t1", body: "Dan's", authorId: DAN.subject, commentId: "r2" }));
    await step(CORA, (d) => hands(d, CORA).editComment({ commentId: "c1", body: "Cora's, edited", editorId: CORA.subject }));
    await step(DAN, (d) => hands(d, DAN).resolve({ threadId: "t1", by: DAN.subject }));
    await step(EDITOR, (d) => hands(d, EDITOR).reopen({ threadId: "t1" }));
    await step(DAN, (d) => hands(d, DAN).resolve({ threadId: "t1", by: DAN.subject }));
    await step(CORA, (d) => hands(d, CORA).reply({ threadId: "t1", body: "Reopened by replying", authorId: CORA.subject }));
    await step(DAN, (d) =>
      hands(d, DAN).applyAnchorWrite("t1", { anchor: { blockId: "p_9", offsetHint: 4 }, ambiguous: true }),
    );
    await step(DAN, (d) => hands(d, DAN).applyAnchorWrite("t1", { orphanedAt: 77 }));
    await step(DAN, (d) => hands(d, DAN).deleteComment({ commentId: "r2", by: DAN.subject }));
    await step(EDITOR, (d) => hands(d, EDITOR).deleteComment({ commentId: "r1", by: EDITOR.subject }));
    await step(DAN, (d) => hands(d, DAN, "model").createThread({ anchor, body: "Via the assistant", authorId: DAN.subject, threadId: "t2" }));
    await step(OWNER, (d) => hands(d, OWNER).deleteThread({ threadId: "t2" }));
    await step(CORA, (d) => hands(d, CORA).createThread({ anchor, body: "Another", authorId: CORA.subject, threadId: "t3", commentId: "c3" }));
    await step(CORA, (d) => hands(d, CORA).deleteComment({ commentId: "c3", by: CORA.subject }));

    const threads = readThreads(await replica(w));
    expect(threads.map((t) => t.id)).toEqual(["t1"]);
    expect(threads[0].comments.map((c) => c.authorId)).toEqual([CORA.subject, CORA.subject]);
    expect(threads[0]).toMatchObject({ status: "open", orphanedAt: 77, ambiguous: true });
  });
});

describe("cost", () => {
  test("judging an append to a 200-thread document stays well inside a mutation's budget", async () => {
    // 200 threads of three comments, landed as stored state without the judge.
    const w = await world();
    const doc = await replica(w);
    const threads = Array.from({ length: 200 }, (_, i) =>
      thread(`t${i}`, [0, 1, 2].map((j) =>
        comment(`t${i}-c${j}`, j === 0 ? CORA.subject : DAN.subject, "A comment of ordinary length, about the words it hangs off."),
      )),
    );
    const state = await updateOf(doc, () => run(doc, CORA.subject, [{ type: "insertNodes", parentId: null, nodes: threads }]));
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("ydocs").withIndex("by_doc", (q) => q.eq("docId", w.docId)).unique())!;
      await ctx.db.insert("yUpdates", { docId: w.docId, seq: 2, update: state });
      await ctx.db.patch(row._id, { seq: 2 });
    });

    const fresh = new Uint8Array(await startThread(doc, CORA.subject, "fresh"));
    const judged = [Y.encodeStateAsUpdate(await replica(w))];
    // Measured at ~28ms for the judge and ~32ms for the whole append (a 430KB
    // state); a mutation has a second of CPU.
    const started = performance.now();
    expect(refuseCommentsUpdate(judged, fresh, { userId: CORA.subject, moderator: false })).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    await expect(append(w, CORA, bytes(fresh))).resolves.toBe(3);
  });
});
