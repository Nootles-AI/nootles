import { describe, expect, it } from "vitest";
import { validateDocument } from "@/app/lib/nml/validate";
import type { NmlCommentThreadBlock } from "@/app/lib/nml/schema";
import {
  CONTEXT_CHARS,
  commentText,
  emptyCommentsDocument,
  threadBlock,
  threadFromBlock,
  threadsOf,
  type Thread,
} from "./types";

const block: NmlCommentThreadBlock = {
  id: "t1",
  type: "commentThread",
  props: {
    anchor: { blockId: "p1", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 8 },
    status: "resolved",
    resolvedBy: "user_b",
    resolvedAt: 20,
    ambiguous: true,
  },
  children: [
    {
      id: "c1",
      type: "comment",
      props: { authorId: "user_a", createdAt: 10, editedAt: 12 },
      content: [{ type: "text", text: "Realistic?", marks: [] }],
      children: [],
    },
  ],
};

describe("comment view types", () => {
  it("reads a thread block as the product sees it", () => {
    expect(threadFromBlock(block)).toEqual({
      id: "t1",
      anchor: block.props.anchor,
      status: "resolved",
      resolvedBy: "user_b",
      resolvedAt: 20,
      ambiguous: true,
      comments: [
        { id: "c1", authorId: "user_a", createdAt: 10, editedAt: 12, content: [{ type: "text", text: "Realistic?", marks: [] }] },
      ],
    } satisfies Thread);
  });

  it("round-trips block → view → block exactly, absent fields staying absent", () => {
    expect(threadBlock(threadFromBlock(block))).toEqual(block);
    const plain: NmlCommentThreadBlock = {
      ...block,
      props: { anchor: block.props.anchor, status: "open" },
      children: [{ ...block.children[0], props: { authorId: "user_a", createdAt: 10 } } as NmlCommentThreadBlock["children"][number]],
    };
    const view = threadFromBlock(plain);
    expect(view.ambiguous).toBe(false);
    expect(view).not.toHaveProperty("resolvedBy");
    expect(view.comments[0]).not.toHaveProperty("editedAt");
    expect(threadBlock(view)).toEqual(plain);
  });

  it("lists a comments document's threads and refuses a page", () => {
    const document = { ...emptyCommentsDocument("d"), blocks: [block] };
    expect(validateDocument(document)).toEqual([]);
    expect(threadsOf(document).map((thread) => thread.id)).toEqual(["t1"]);
    expect(() => threadsOf({ schemaVersion: 1, documentId: "p", blocks: [] })).toThrow(/comments document/);
  });

  it("an empty comments document is valid and has no threads", () => {
    const empty = emptyCommentsDocument("d");
    expect(validateDocument(empty)).toEqual([]);
    expect(threadsOf(empty)).toEqual([]);
  });

  it("reads a comment's words as plain text", () => {
    expect(
      commentText([
        { type: "text", text: "Ask ", marks: [] },
        { type: "link", href: "https://x.test", content: [{ type: "text", text: "Ada", marks: ["bold"] }] },
        { type: "text", text: " about ", marks: [] },
        { type: "pageRef", id: "r1", pageId: "pg", fallbackTitle: "Roadmap" },
        { type: "math", id: "m1", latex: "x^2" },
        { type: "checkbox", id: "k1", checked: true },
      ]),
    ).toBe("Ask Ada about Roadmapx^2");
  });

  it("keeps 32 characters of context", () => {
    expect(CONTEXT_CHARS).toBe(32);
  });
});
