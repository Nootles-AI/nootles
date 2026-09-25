import { describe, expect, test } from "vitest";
import type { AnyBlock } from "../projection";
import { pageHtml } from "./clientTools";

const para = (n: number): AnyBlock =>
  ({
    id: `b${n}`,
    type: "paragraph",
    props: {},
    content: [{ type: "text", text: `Paragraph ${n}. ${"words ".repeat(100)}`, styles: {} }],
    children: [],
  }) as unknown as AnyBlock;

/** Past the 24K-character read budget, so a read has to come in parts. */
const long = Array.from({ length: 60 }, (_, i) => para(i));

describe("a long page reads in parts", () => {
  test("a read that stops says which block to read on after", () => {
    const first = pageHtml(long, "Overview");
    const last = /Read on with after: "(b\d+)"/.exec(first)?.[1];
    expect(last).toBeDefined();
    expect(first).toContain(`id="${last}"`);
    expect(first).not.toContain(`id="b${Number(last!.slice(1)) + 1}"`);
  });

  test("reading on picks up at the next block, and the parts cover the page", () => {
    const seen = new Set<string>();
    let after: string | undefined;
    for (let part = 0; part < 10; part++) {
      const html = pageHtml(long, "Overview", { after });
      if (after) expect(html).toContain("before it are not shown");
      for (const m of html.matchAll(/<p id="(b\d+)"/g)) {
        expect(seen.has(m[1])).toBe(false);
        seen.add(m[1]);
      }
      after = /Read on with after: "(b\d+)"/.exec(html)?.[1];
      if (!after) break;
    }
    expect(seen.size).toBe(long.length);
  });

  test("an id the page does not have is said plainly", () => {
    expect(() => pageHtml(long, "Overview", { after: "nope" })).toThrow(/no top-level block "nope"/);
  });
});
