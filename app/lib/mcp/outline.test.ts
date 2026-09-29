import { describe, expect, test } from "vitest";
import type { NmlBlock, NmlDocument } from "@/app/lib/nml/schema";
import { inlineText, nmlOutline, nmlSnippet } from "./outline";

const text = (t: string) => ({ type: "text" as const, text: t, marks: [] });
const para = (id: string, t: string, children: NmlBlock[] = []): NmlBlock => ({
  id,
  type: "paragraph",
  props: {},
  content: t ? [text(t)] : [],
  children,
});

const doc = (blocks: NmlBlock[]): NmlDocument => ({ schemaVersion: 1, documentId: "d", blocks });

describe("outline", () => {
  test("inline atoms read as a person would say them", () => {
    expect(
      inlineText([
        text("see "),
        { type: "link", href: "https://x", content: [text("the spec")] },
        text(" and "),
        { type: "math", id: "m", latex: "x^2" },
        text(" "),
        { type: "pageRef", id: "r", pageId: "p", fallbackTitle: "Roadmap" },
        text(" "),
        { type: "checkbox", id: "c", checked: true },
      ]),
    ).toBe("see the spec and $x^2$ @Roadmap ☑");
  });

  test("walks nested blocks in order with depth, heading level, check state and code language", () => {
    const outline = nmlOutline(
      doc([
        { id: "h", type: "heading", props: { level: 2 }, content: [text("Plan")], children: [] },
        {
          id: "l1",
          type: "bulletListItem",
          props: {},
          content: [text("parent")],
          children: [{ id: "l2", type: "checkListItem", props: { checked: true }, content: [text("done")], children: [] }],
        },
        { id: "c", type: "codeBlock", props: { language: "ts" }, code: "const x = 1;", children: [] },
        { id: "dv", type: "divider", props: {}, children: [] },
      ]),
    );
    expect(outline.total).toBe(5);
    expect(outline.truncated).toBe(false);
    expect(outline.blocks).toEqual([
      { id: "h", type: "heading", depth: 0, text: "Plan", level: 2 },
      { id: "l1", type: "bulletListItem", depth: 0, text: "parent" },
      { id: "l2", type: "checkListItem", depth: 1, text: "done", checked: true },
      { id: "c", type: "codeBlock", depth: 0, text: "const x = 1;", language: "ts" },
      { id: "dv", type: "divider", depth: 0, text: "" },
    ]);
  });

  test("caps blocks and characters but still counts every block", () => {
    const many = Array.from({ length: 10 }, (_, i) => para(`p${i}`, "x".repeat(50)));
    const outline = nmlOutline(doc(many), { maxBlocks: 3, maxChars: 10 });
    expect(outline.blocks).toHaveLength(3);
    expect(outline.total).toBe(10);
    expect(outline.truncated).toBe(true);
    expect(outline.blocks[0].text).toBe("xxxxxxxxx…");
  });

  test("tables read row by row; media by caption", () => {
    const outline = nmlOutline(
      doc([
        {
          id: "t",
          type: "table",
          props: { headerRows: 1 },
          columns: [{ id: "c1" }, { id: "c2" }],
          rows: [
            { id: "r1", cells: [{ id: "a", content: [text("Name")] }, { id: "b", content: [text("Owner")] }] },
            { id: "r2", cells: [{ id: "c", content: [text("Launch")] }, { id: "d", content: [text("Aryan")] }] },
          ],
          children: [],
        },
        { id: "i", type: "image", props: { caption: "Mood board", source: { kind: "url", url: "https://x/y.png" } }, children: [] },
      ]),
    );
    expect(outline.blocks[0].text).toBe("Name │ Owner\nLaunch │ Aryan");
    expect(outline.blocks[1].text).toBe("Mood board");
  });

  test("the snippet is the first words anywhere, skipping empty blocks", () => {
    expect(nmlSnippet(doc([para("e", ""), para("p", "  hello \n world  ")]))).toBe("hello world");
    expect(nmlSnippet(doc([para("e", "", [para("c", "nested first")])]))).toBe("nested first");
    expect(nmlSnippet(doc([]))).toBe("");
    expect(nmlSnippet(doc([para("p", "y".repeat(300))]), { max: 20 })).toHaveLength(20);
  });

  test("a heading that only repeats the page title is not the snippet", () => {
    const page = doc([
      { id: "h", type: "heading", props: { level: 1 }, content: [text("Launch Plan")], children: [] },
      para("p", "Ship it this week"),
    ]);
    expect(nmlSnippet(page, { title: "launch plan " })).toBe("Ship it this week");
    expect(nmlSnippet(page)).toBe("Launch Plan");
  });
});
