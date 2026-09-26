import { describe, expect, it } from "vitest";
import { AI } from "../aiConfig";
import type { AnyBlock } from "../projection";
import { toDocHtml, toDocHtmlSplit } from "./serialize";

// The completion lane's projection (NT-101): how much of the page the model is
// shown either side of the caret. It used to be four TOP-LEVEL blocks, and in
// BlockNote every list item is one, so a twelve-item list was read as its last
// four items while 4000 characters of budget went unused.

const text = (t: string) => [{ type: "text", text: t, styles: {} }];
const block = (id: string, type: string, t: string): AnyBlock =>
  ({ id, type, props: {}, content: text(t), children: [] }) as unknown as AnyBlock;

const lens = (title = "Release checklist") => ({
  title,
  ...AI.projection,
  collapseDrawn: true,
});

describe("completion projection window", () => {
  it("shows a whole twelve-item list, not its last four items", () => {
    const blocks = [
      block("h", "heading", "Launch steps"),
      ...Array.from({ length: 12 }, (_, i) =>
        block(`li${i + 1}`, "numberedListItem", `Step ${i + 1}: verify widget${i + 1}`),
      ),
    ];
    const split = toDocHtmlSplit(blocks, "li12", "Step 12: verify widget12".length, lens());
    expect(split).not.toBeNull();
    expect(split!.prefix).toContain("<title>Release checklist</title>");
    expect(split!.prefix).toContain("Launch steps");
    for (let i = 1; i < 12; i++) expect(split!.prefix).toContain(`widget${i}<`);
    expect(split!.prefix.endsWith("widget12")).toBe(true);
  });

  it("keeps a long page inside the wire's caps, nearest blocks first", () => {
    const blocks = Array.from({ length: 300 }, (_, i) =>
      block(`p${i}`, "paragraph", `Paragraph ${i} ${"lorem ipsum ".repeat(8)}`),
    );
    const split = toDocHtmlSplit(blocks, "p150", 5, lens())!;
    // Within the cap, the wire's head trim never runs, so the title survives.
    expect(split.prefix.length).toBeLessThanOrEqual(AI.fim.maxBefore);
    expect(split.suffix.length).toBeLessThanOrEqual(AI.fim.maxAfter);
    expect(split.prefix.startsWith("<title>Release checklist</title>")).toBe(true);
    // Contiguous around the caret, and it uses most of the budget.
    expect(split.prefix).toContain("Paragraph 149 ");
    expect(split.suffix).toContain("Paragraph 151 ");
    expect(split.prefix.length).toBeGreaterThan(AI.fim.maxBefore * 0.75);
    expect(split.prefix).not.toContain("Paragraph 0 ");
    expect(split.suffix).not.toContain("Paragraph 299 ");
  });

  it("always shows the blocks right beside the caret, even when one is over the cap", () => {
    const huge = block("big", "paragraph", "x".repeat(AI.fim.maxBefore + 500));
    const blocks = [
      block("a", "paragraph", "far above"),
      huge,
      block("c", "paragraph", "caret here"),
      block("after", "paragraph", "y".repeat(AI.fim.maxAfter + 500)),
      block("far", "paragraph", "far below"),
    ];
    const split = toDocHtmlSplit(blocks, "c", 5, lens())!;
    expect(split.prefix).toContain("xxxx");
    expect(split.prefix).not.toContain("far above");
    expect(split.suffix).toContain("yyyy");
    expect(split.suffix).not.toContain("far below");
  });

  // The compiler diffs a completion against `toDocHtml` of the same blocks
  // WITHOUT the caret. If the caret's own characters could move the window's
  // edge, a block shown on one side only would read as one the model deleted.
  it("chooses the same blocks with and without the caret", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 200; run++) {
      const n = 5 + Math.floor(rand() * 120);
      const blocks = Array.from({ length: n }, (_, i) => {
        const kind = rand() < 0.4 ? "bulletListItem" : "paragraph";
        return block(`b${i}`, kind, "w".repeat(1 + Math.floor(rand() * 400)));
      });
      const at = Math.floor(rand() * n);
      const len = ((blocks[at].content as Array<{ text: string }>)[0].text).length;
      const offset = Math.floor(rand() * (len + 1));
      const title = "t".repeat(Math.floor(rand() * 80));
      const split = toDocHtmlSplit(blocks, `b${at}`, offset, lens(title))!;
      const plain = toDocHtml(blocks, { ...lens(title), cursorBlockId: `b${at}` });
      expect(split.prefix + split.suffix).toBe(plain);
    }
  });
});
