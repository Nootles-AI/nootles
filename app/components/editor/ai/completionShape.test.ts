import { describe, expect, it } from "vitest";
import { completionShape, wordsAfterCaret } from "./completionShape";

const create = (suffix: string, cell = false) =>
  completionShape({ allowBlocks: true, cell, suffix });

describe("completionShape (NT-102)", () => {
  it("asks for prose mid-sentence in create mode", () => {
    expect(create(" and then we ship.</p>\n<p>Next</p>")).toBe("prose");
  });

  it("asks for structure at the end of a block", () => {
    expect(create("</p>\n<p>Next paragraph</p>")).toBe("structure");
    expect(create("</li>\n<li>Step 2</li>\n</ol>")).toBe("structure");
    expect(create("</h2>")).toBe("structure");
    expect(create("")).toBe("structure");
  });

  it("reads trailing whitespace as the end of the block", () => {
    expect(create("   </p>\n<p>Next</p>")).toBe("structure");
    expect(create("&nbsp;</p>")).toBe("structure");
  });

  it("counts inline marks as part of the sentence", () => {
    expect(create("<strong>bold</strong> words</p>")).toBe("prose");
    expect(create(' <a href="https://x.test">link</a></p>')).toBe("prose");
    expect(create("<nt-math>x^2</nt-math></p>")).toBe("prose");
    expect(create("<br>second line</p>")).toBe("prose");
  });

  it("does not read the blocks after the caret's block as its words", () => {
    expect(create("</p>\n<ul>\n<li>a</li>\n</ul>")).toBe("structure");
  });

  it("stops at a line break before the next block", () => {
    expect(create("\n<ul><li>child</li></ul></p>")).toBe("structure");
  });

  it("keeps a table cell prose, and the Complete end complete", () => {
    expect(create("</td></tr>", true)).toBe("prose");
    expect(completionShape({ allowBlocks: false, cell: false, suffix: "</p>" })).toBe("complete");
    expect(completionShape({ allowBlocks: false, cell: false, suffix: " more</p>" })).toBe("complete");
  });

  it("wordsAfterCaret ignores an empty inline mark", () => {
    expect(wordsAfterCaret("<strong></strong></p>")).toBe(false);
  });
});
