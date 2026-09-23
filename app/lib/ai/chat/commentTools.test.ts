import * as Y from "yjs";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { PageComments } from "@/app/components/comments/PageComments";
import type { CommentAccess } from "@/app/components/comments/access";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { applyAnchorWrite, CommentsStore, threadsSnapshot } from "@/app/lib/comments/store";
import { commentText, emptyCommentsDocument, type CommentAnchor } from "@/app/lib/comments/types";
import { validateDocument } from "@/app/lib/nml/validate";
import { createNmlYDoc, decodeNmlDocument, isNmlOrigin, type NmlTransactionOrigin } from "@/app/lib/nml/yjs";
import {
  chatDigest,
  createComment,
  idsForCall,
  namer,
  pageText,
  readComments,
  replyComment,
  resolveComment,
  USER_LABEL,
  type CommentEvent,
  type CommentsScope,
  type PageText,
  type Person,
} from "./commentTools";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: Array<{ _tiptapEditor?: { destroy(): void } }> = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

type Blocks = PartialBlock<
  (typeof readerSchema)["blockSchema"],
  (typeof readerSchema)["inlineContentSchema"],
  (typeof readerSchema)["styleSchema"]
>[];

const PAGE = "page1" as Id<"pages">;
const ME = "user_ada";
const PEOPLE: Person[] = [
  { userId: "user_bram", name: "Bram Stoker" },
  { userId: "user_cleo", name: "Cleo" },
  { userId: "user_anon", name: null },
];
const FULL: CommentAccess = { canRead: true, canComment: true };
const READ_ONLY: CommentAccess = { canRead: true, canComment: false };
const NONE: CommentAccess = { canRead: false, canComment: false };

/** A real editor over real blocks, read the way the tool reads the open page. */
function editorText(blocks: Blocks): PageText {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return pageText(editor as unknown as LiveEditor);
}

const PAGE_TEXT = () =>
  editorText([
    { id: "h1", type: "heading", props: { level: 2 }, content: "Launch plan" },
    {
      id: "p1",
      type: "paragraph",
      content: [
        { type: "text", text: "We will ship it ", styles: {} },
        { type: "text", text: "by Friday", styles: { bold: true } },
        { type: "text", text: " if the review lands.", styles: {} },
      ],
    },
    { id: "p2", type: "paragraph", content: "the cat sat on the mat and the dog sat on the log" },
    { id: "p3", type: "paragraph", content: "na ".repeat(30).trim() },
    { id: "t1", type: "table", content: { type: "tableContent", rows: [{ cells: ["cell words"] }] } },
  ]);

let doc: Y.Doc;
let events: CommentEvent[];
let updates: number;
let seen: NmlTransactionOrigin[];
let clock = 1_727_000_000_000;

beforeEach(() => {
  doc = createNmlYDoc(emptyCommentsDocument("comments"));
  events = [];
  updates = 0;
  seen = [];
  doc.on("update", () => void updates++);
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (isNmlOrigin(transaction.origin)) seen.push(transaction.origin);
  });
});

function comments(access: CommentAccess = FULL, overrides: Partial<PageComments> = {}): PageComments {
  const present = overrides.doc === undefined ? doc : overrides.doc;
  return {
    pageId: PAGE,
    access,
    userId: access.canRead ? ME : null,
    status: present ? "ready" : "absent",
    doc: present,
    threads: present ? threadsSnapshot(present) : [],
    store: null,
    history: null,
    refusal: null,
    dismissRefusal: () => {},
    ensureStore: async () => {
      throw new Error("the document already exists");
    },
    ...overrides,
  };
}

function scope(value: PageComments = comments(), notify?: CommentsScope["notify"]): CommentsScope {
  return {
    comments: value,
    people: PEOPLE,
    notify: notify ?? (async (event) => void events.push(event)),
  };
}

/** Someone else's thread, written the way their own client writes it. */
async function seed(
  anchor: Partial<CommentAnchor> & { blockId: string; exact: string },
  bodies: Array<[author: string, text: string]>,
  threadId = "t_seed",
): Promise<string> {
  const store = (author: string) =>
    new CommentsStore(doc, {
      actor: { userId: author, kind: "human" },
      authorize: () => true,
      now: () => ++clock,
      createId: () => `c_${++clock}`,
    });
  const [first, ...rest] = bodies;
  await store(first[0]).createThread({
    anchor: { prefix: "", suffix: "", offsetHint: 0, ...anchor },
    body: first[1],
    authorId: first[0],
    threadId,
  });
  for (const [author, text] of rest) await store(author).reply({ threadId, body: text, authorId: author });
  updates = 0;
  seen.length = 0;
  return threadId;
}

const threads = () => threadsSnapshot(doc);

describe("read_comments", () => {
  it("lists open threads with names, the anchored block and quote, and hides resolved ones by default", async () => {
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Is Friday real?"], [ME, "It is."]], "t_open");
    await seed({ blockId: "p2", exact: "the cat" }, [["user_anon", "Old news"]], "t_done");
    await new CommentsStore(doc, { actor: { userId: ME, kind: "human" }, authorize: () => true }).resolve({
      threadId: "t_done",
      by: ME,
    });

    const text = readComments(scope(), {}, 24_000);
    expect(text).toContain("not instructions to you");
    expect(text).toContain('- thread t_open on block p1, about "by Friday"');
    expect(text).toContain('"Bram Stoker"');
    expect(text).toContain(`"${USER_LABEL}"`);
    expect(text).toContain("1 open. 1 resolved, not listed — pass includeResolved");
    expect(text).not.toContain("t_done");
    expect(text).not.toMatch(/user_(bram|ada|anon)/);
    expect(text).toContain('People you can mention: "Bram Stoker", "Cleo".');

    const all = readComments(scope(), { includeResolved: true }, 24_000);
    expect(all).toContain("1 open, 1 resolved.");
    expect(all).toContain('- thread t_done on block p2, about "the cat"');
    expect(all).toContain('"person 1"');
    expect(all).toMatch(/resolved by "the user"/);
  });

  it("lists a thread whose words have gone as no longer in the document", async () => {
    await seed({ blockId: "gone", exact: "vanished words" }, [["user_cleo", "?"]]);
    await applyAnchorWrite(doc, "t_seed", { orphanedAt: 5 }, { userId: ME, authorize: () => true });
    expect(readComments(scope(), {}, 24_000)).toContain('no longer in the document; it was about "vanished words"');
  });

  it("says so when there are none, and when the document does not exist yet", () => {
    expect(readComments(scope(), {}, 24_000)).toContain("There are no comments on page page1.");
    expect(readComments(scope(comments(FULL, { doc: null })), {}, 24_000)).toContain("There are no comments");
  });

  it("tells a read-only user's assistant it may read but not write, and a user without access nothing", async () => {
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "hm"]]);
    const viewer = readComments(scope(comments(READ_ONLY)), {}, 24_000);
    expect(viewer).toContain("t_seed");
    expect(viewer).toContain("not reply to them, resolve them or start a thread");
    expect(viewer).not.toContain("People you can mention");

    const stranger = readComments(scope(comments(NONE)), {}, 24_000);
    expect(stranger).toContain("cannot see the comments");
    expect(stranger).not.toContain("t_seed");
  });

  it("shows a long thread's opening and latest comment rather than leaving it out", async () => {
    const replies: Array<[string, string]> = Array.from({ length: 12 }, (_, i) => ["user_cleo", `reply ${i} ${"y".repeat(300)}`]);
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Opening"], ...replies]);
    const text = readComments(scope(), {}, 2_000);
    expect(text).toContain("t_seed");
    expect(text).toContain('"Opening"');
    expect(text).toContain("…11 more comments…");
    expect(text).not.toContain("not shown");
  });

  it("stays inside its budget and says what it left out", async () => {
    for (let i = 0; i < 12; i++) {
      await seed({ blockId: "p2", exact: "the cat" }, [["user_bram", "x".repeat(900)]], `t_${i}`);
    }
    const text = readComments(scope(), {}, 4_000);
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toMatch(/…and \d+ more threads not shown/);
  });
});

describe("create_comment", () => {
  it("hangs a thread off the quoted words, with context read from the page, as the model acting for the user", async () => {
    const result = await createComment(
      scope(),
      { blockId: "p1", quote: "by Friday", text: "Can we commit to this? @Cleo", mentions: ["@cleo"] },
      PAGE_TEXT(),
      "call_1",
    );
    const ids = idsForCall("call_1");
    expect(result).toContain(`Started thread ${ids.thread} on block p1, about "by Friday"`);
    const [thread] = threads();
    expect(thread).toMatchObject({
      id: ids.thread,
      status: "open",
      ambiguous: false,
      anchor: { blockId: "p1", exact: "by Friday", prefix: "We will ship it ", suffix: " if the review lands.", offsetHint: 16 },
    });
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({ id: ids.comment, authorId: ME });
    expect(commentText(thread.comments[0].content)).toBe("Can we commit to this? @Cleo");
    expect(seen.map((o) => o.actor)).toEqual([{ userId: ME, kind: "model" }]);
    expect(seen[0].command).toBe("comments.create-thread");
    expect(events).toEqual([
      { pageId: PAGE, threadId: ids.thread, kind: "create", commentId: ids.comment, mentions: ["user_cleo"] },
    ]);
    // The notice carries ids, never the words.
    expect(JSON.stringify(events)).not.toContain("commit");
    expect(validateDocument(decodeNmlDocument(doc))).toEqual([]);
  });

  it("refuses an invented quote without writing anything, and shows the block", async () => {
    const result = await createComment(
      scope(),
      { blockId: "p1", quote: "by next Tuesday", text: "?" },
      PAGE_TEXT(),
      "call_x",
    );
    expect(result).toContain("Nothing was written.");
    expect(result).toContain('Block "p1" does not say "by next Tuesday"');
    expect(result).toContain('The block says: "We will ship it by Friday if the review lands."');
    expect(updates).toBe(0);
    expect(events).toEqual([]);
  });

  it("refuses a paraphrase, a quote with markup, and a quote from another block", async () => {
    const text = PAGE_TEXT();
    for (const quote of ["by friday", "<strong>by Friday</strong>", "ship it by Friday if the review landed"]) {
      expect(await createComment(scope(), { blockId: "p1", quote, text: "?" }, text, `c_${quote}`)).toContain(
        "Nothing was written.",
      );
    }
    expect(await createComment(scope(), { blockId: "h1", quote: "by Friday", text: "?" }, text, "c_h")).toContain(
      "Nothing was written.",
    );
    expect(updates).toBe(0);
    expect(events).toEqual([]);
  });

  it("refuses a block the page does not have, or one without prose", async () => {
    const text = PAGE_TEXT();
    for (const blockId of ["p_7f3a", "t1"]) {
      const result = await createComment(scope(), { blockId, quote: "cell words", text: "?" }, text, `c_${blockId}`);
      expect(result).toContain(`This page has no block "${blockId}" with text in it`);
    }
    expect(await createComment(scope(), { blockId: "p1", quote: "  ", text: "?" }, text, "c_e")).toContain(
      "A comment needs a quote",
    );
    expect(updates).toBe(0);
  });

  it("asks for context when the words repeat, then takes the occurrence the context names", async () => {
    const text = PAGE_TEXT();
    const unsure = await createComment(scope(), { blockId: "p2", quote: "sat on the", text: "?" }, text, "c_1");
    expect(unsure).toContain('"sat on the" appears 2 times in block "p2"');
    expect(updates).toBe(0);

    const sure = await createComment(
      scope(),
      { blockId: "p2", quote: "sat on the", prefix: "the dog ", text: "Which dog?" },
      text,
      "c_2",
    );
    expect(sure).toContain("Started thread");
    const [thread] = threads();
    expect(thread.anchor).toMatchObject({ exact: "sat on the", prefix: " cat sat on the mat and the dog ", suffix: " log" });
    expect(thread.ambiguous).toBe(false);
  });

  it("stores words whose surroundings are identical as ambiguous, and says so", async () => {
    const result = await createComment(scope(), { blockId: "p3", quote: "na", text: "Chorus?" }, PAGE_TEXT(), "c_na");
    expect(result).toContain("Started thread");
    expect(result).toContain("appear more than once");
    const [thread] = threads();
    expect(thread.ambiguous).toBe(true);
    expect(validateDocument(decodeNmlDocument(doc))).toEqual([]);
  });

  it("writes once when the same call runs again", async () => {
    const text = PAGE_TEXT();
    const input = { blockId: "p1", quote: "by Friday", text: "Once." };
    await createComment(scope(), input, text, "call_same");
    const writes = updates;
    const again = await createComment(scope(comments()), input, text, "call_same");
    expect(again).toContain("already exists");
    expect(updates).toBe(writes);
    expect(threads()).toHaveLength(1);
    expect(events).toHaveLength(1);

    // Replayed after the quoted words changed: still "already", never a refusal
    // that would send the model to post it a second time.
    const edited = editorText([{ id: "p1", type: "paragraph", content: "We will ship it someday." }]);
    expect(await createComment(scope(comments()), input, edited, "call_same")).toContain("already exists");
    expect(updates).toBe(writes);
  });

  it("refuses a read-only user's assistant and one without access, writing nothing", async () => {
    for (const access of [READ_ONLY, NONE]) {
      const result = await createComment(
        scope(comments(access)),
        { blockId: "p1", quote: "by Friday", text: "?" },
        PAGE_TEXT(),
        "c_denied",
      );
      expect(result).toMatch(/Nothing was written|cannot see/);
    }
    expect(updates).toBe(0);
    expect(events).toEqual([]);
  });

  it("mints the comments document for the page's first comment", async () => {
    const fresh = createNmlYDoc(emptyCommentsDocument("minted"));
    let minted = 0;
    const value = comments(FULL, {
      doc: null,
      ensureStore: async () => {
        minted++;
        return new CommentsStore(fresh, { actor: { userId: ME, kind: "human" }, authorize: () => true });
      },
    });
    await createComment(scope(value), { blockId: "p1", quote: "Friday", text: "First!" }, PAGE_TEXT(), "c_first");
    expect(minted).toBe(1);
    expect(threadsSnapshot(fresh)).toHaveLength(1);
  });

  it("refuses words only the pending review proposes, and checks against the shared page", async () => {
    const shared = editorText([{ id: "p1", type: "paragraph", content: "ship it by Friday" }]).shared;
    const proposed = editorText([{ id: "p1", type: "paragraph", content: "ship it by Monday" }]).shared;
    const page: PageText = { shared, proposed };
    const only = await createComment(scope(), { blockId: "p1", quote: "by Monday", text: "?" }, page, "c_m");
    expect(only).toContain("waiting for the user's review");
    expect(updates).toBe(0);
    const kept = await createComment(scope(), { blockId: "p1", quote: "by Friday", text: "?" }, page, "c_f");
    expect(kept).toContain("Started thread");
  });

  it("refuses a mention of someone who is not on the project, or a name two people share, before writing", async () => {
    const text = PAGE_TEXT();
    const stranger = await createComment(
      scope(),
      { blockId: "p1", quote: "by Friday", text: "@Zed look", mentions: ["Zed"] },
      text,
      "c_z",
    );
    expect(stranger).toContain('Nobody on this project is called "Zed"');
    expect(stranger).toContain('"Bram Stoker", "Cleo"');
    const twins = await createComment(
      { ...scope(), people: [...PEOPLE, { userId: "user_cleo2", name: "cleo" }] },
      { blockId: "p1", quote: "by Friday", text: "@Cleo", mentions: ["Cleo"] },
      text,
      "c_t",
    );
    expect(twins).toContain('More than one person on this project is called "Cleo"');
    expect(updates).toBe(0);
  });

  it("keeps the comment and says so when the notice fails", async () => {
    const result = await createComment(
      scope(comments(), async () => {
        throw new Error("offline");
      }),
      { blockId: "p1", quote: "by Friday", text: "Still here" },
      PAGE_TEXT(),
      "c_n",
    );
    expect(result).toContain("It is written, but telling people about it failed (offline); do not write it again.");
    expect(threads()).toHaveLength(1);
  });

  it("refuses an empty comment", async () => {
    expect(await createComment(scope(), { blockId: "p1", quote: "by Friday", text: " " }, PAGE_TEXT(), "c")).toContain(
      "A comment needs some words.",
    );
    expect(updates).toBe(0);
  });
});

describe("reply_comment", () => {
  it("replies as the model acting for the user and tells the thread's participants", async () => {
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Friday?"], ["user_cleo", "+1"]]);
    const result = await replyComment(scope(comments()), { threadId: "t_seed", text: "Yes — @Bram Stoker", mentions: ["Bram Stoker"] }, "call_r");
    expect(result).toBe("Replied to thread t_seed, under the user's name.");
    const [thread] = threads();
    expect(thread.comments.map((c) => [c.authorId, commentText(c.content)])).toEqual([
      ["user_bram", "Friday?"],
      ["user_cleo", "+1"],
      [ME, "Yes — @Bram Stoker"],
    ]);
    expect(thread.comments[2].id).toBe(idsForCall("call_r").comment);
    expect(seen.map((o) => o.actor)).toEqual([{ userId: ME, kind: "model" }]);
    expect(events).toEqual([
      {
        pageId: PAGE,
        threadId: "t_seed",
        kind: "reply",
        commentId: idsForCall("call_r").comment,
        mentions: ["user_bram"],
        participants: ["user_bram", "user_cleo"],
      },
    ]);
  });

  it("reopens a resolved thread and says so", async () => {
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Friday?"]]);
    await new CommentsStore(doc, { actor: { userId: "user_bram", kind: "human" }, authorize: () => true }).resolve({
      threadId: "t_seed",
      by: "user_bram",
    });
    const result = await replyComment(scope(comments()), { threadId: "t_seed", text: "One more thing" }, "call_o");
    expect(result).toContain("a reply reopens it");
    expect(threads()[0].status).toBe("open");
  });

  it("refuses a thread that does not exist, and writes once when the call runs again", async () => {
    expect(await replyComment(scope(), { threadId: "t_nope", text: "hi" }, "c")).toContain(
      'There is no thread "t_nope" on this page',
    );
    expect(await replyComment(scope(comments(FULL, { doc: null })), { threadId: "t_nope", text: "hi" }, "c")).toContain(
      "There is no thread",
    );
    expect(updates).toBe(0);

    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Friday?"]]);
    await replyComment(scope(comments()), { threadId: "t_seed", text: "Once" }, "call_same");
    const writes = updates;
    const again = await replyComment(scope(comments()), { threadId: "t_seed", text: "Once" }, "call_same");
    expect(again).toContain("already on thread t_seed");
    expect(updates).toBe(writes);
    expect(threads()[0].comments).toHaveLength(2);
    expect(events).toHaveLength(1);
  });

  it("refuses a read-only user's assistant", async () => {
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Friday?"]]);
    expect(await replyComment(scope(comments(READ_ONLY)), { threadId: "t_seed", text: "hi" }, "c")).toContain(
      "may read this page's comments but not add to them",
    );
    expect(updates).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("resolve_comment", () => {
  it("resolves as the model acting for the user, once", async () => {
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Friday?"]]);
    expect(await resolveComment(scope(comments()), { threadId: "t_seed" })).toBe("Resolved thread t_seed. The user can reopen it.");
    expect(threads()[0]).toMatchObject({ status: "resolved", resolvedBy: ME });
    expect(seen.map((o) => o.actor)).toEqual([{ userId: ME, kind: "model" }]);
    expect(events).toEqual([{ pageId: PAGE, threadId: "t_seed", kind: "resolve", mentions: [], participants: ["user_bram"] }]);

    const writes = updates;
    expect(await resolveComment(scope(comments()), { threadId: "t_seed" })).toContain("already resolved");
    expect(updates).toBe(writes);
    expect(events).toHaveLength(1);
  });

  it("refuses a missing thread and a read-only user's assistant", async () => {
    expect(await resolveComment(scope(), { threadId: "t_nope" })).toContain("There is no thread");
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Friday?"]]);
    expect(await resolveComment(scope(comments(READ_ONLY)), { threadId: "t_seed" })).toContain("Nothing was written.");
    expect(await resolveComment(scope(comments(NONE)), { threadId: "t_seed" })).toContain("cannot see");
    expect(updates).toBe(0);
    expect(threads()[0].status).toBe("open");
  });
});

describe("the chat request's digest", () => {
  it("is sent only for a page with threads the user may read, with names in place of ids", async () => {
    expect(chatDigest(null, PEOPLE)).toBeUndefined();
    expect(chatDigest(comments(), PEOPLE)).toBeUndefined();
    await seed({ blockId: "p1", exact: "by Friday" }, [["user_bram", "Friday?"], [ME, "yes"], ["user_anon", "ok"]]);
    expect(chatDigest(comments(NONE, { threads: threads() }), PEOPLE)).toBeUndefined();

    const digest = chatDigest(comments(READ_ONLY), PEOPLE)!;
    expect(digest.pageId).toBe(PAGE);
    expect(digest.threads[0].comments.map((c) => c.author)).toEqual(["Bram Stoker", USER_LABEL, "person 1"]);
    expect(JSON.stringify(digest)).not.toMatch(/user_/);
  });

  it("names the user, and people by their trimmed names", () => {
    const nameOf = namer([{ userId: "u1", name: "  Ada  " }, { userId: "u2", name: "" }], "me");
    expect([nameOf("me"), nameOf("u1"), nameOf("u2")]).toEqual([USER_LABEL, "Ada", undefined]);
  });
});

describe("ids for a call", () => {
  it("are stable per call, distinct across calls, and safe as ids", () => {
    expect(idsForCall("toolu_01ABC")).toEqual(idsForCall("toolu_01ABC"));
    expect(idsForCall("a").thread).not.toBe(idsForCall("b").thread);
    const odd = idsForCall("call/with spaces:and.dots".repeat(10));
    expect(odd.thread).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(odd.comment).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});
