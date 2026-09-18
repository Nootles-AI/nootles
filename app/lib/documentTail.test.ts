import { describe, expect, it } from "vitest";
import { isEmptyParagraphBlock, lastContentBlock } from "./documentTail";

const paragraph = (id: string, content: unknown[] = [], children: unknown[] = []) => ({
  id,
  type: "paragraph",
  props: {},
  content,
  children,
});

describe("document tail helpers", () => {
  it("recognizes only an unnested empty paragraph as the writing row", () => {
    expect(isEmptyParagraphBlock(paragraph("tail"))).toBe(true);
    expect(isEmptyParagraphBlock(paragraph("text", [{ type: "text", text: "x" }]))).toBe(false);
    expect(isEmptyParagraphBlock(paragraph("parent", [], [paragraph("child")]))).toBe(false);
    expect(isEmptyParagraphBlock({ ...paragraph("heading"), type: "heading" })).toBe(false);
  });

  it("finds authored content before the terminal writing row", () => {
    const body = paragraph("body", [{ type: "text", text: "Body" }]);
    const tail = paragraph("tail");
    expect(lastContentBlock([body, tail])).toBe(body);
    expect(lastContentBlock([body])).toBe(body);
    expect(lastContentBlock([tail])).toBeUndefined();
  });
});
