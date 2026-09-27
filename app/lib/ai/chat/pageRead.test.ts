import { describe, expect, test } from "vitest";
import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { SceneNode } from "@/app/components/editor/canvas/scene/types";
import { AI } from "../aiConfig";
import type { AnyBlock } from "../projection";
import { pageHtml } from "./clientTools";

(globalThis as { DOMParser?: unknown }).DOMParser = class {
  parseFromString(html: string) {
    return parseHTML(html).document;
  }
};

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

/** A board of 150 labelled boxes: a stub of a few K, some 20K read whole. */
function diagram(id: string): AnyBlock {
  const nodes: SceneNode[] = Array.from({ length: 150 }, (_, i) => ({
    id: `s${i}`,
    kind: "rect",
    x: i * 10,
    y: 0,
    w: 100,
    h: 40,
    rot: 0,
    label: `Box ${i}`,
    locked: false,
    hidden: false,
    attrs: {},
    style: { background: "#f4f4f4", "border-radius": "8px" },
  }));
  const data = serializeScene({ w: 1600, h: 400, style: {}, nodes, edges: [], attrs: {} });
  return { id, type: "canvas", props: { data }, content: undefined, children: [] } as unknown as AnyBlock;
}

const album = (id: string): AnyBlock =>
  ({ id, type: "album", props: { data: "" }, content: undefined, children: [] }) as unknown as AnyBlock;

/** Box labels only an expanded read carries — a stub has them in its text="…". */
const expanded = (html: string) => html.includes('<nt-rect id="s149"');

describe("expanding a block uncaps that block, not the page (NT-94)", () => {
  // 200 paragraphs of ~620 characters: some 124K, five reads' worth.
  const paras = Array.from({ length: 200 }, (_, i) => para(i));
  const whole = pageHtml([diagram("d")], "", { expand: ["d"] }).length;
  const cap = AI.chat.maxPageChars;

  test("the fixture's diagram is big whole and small as a stub", () => {
    expect(whole).toBeGreaterThan(15_000);
    expect(pageHtml([diagram("d")], "").length).toBeLessThan(3_000);
  });

  test("a diagram near the top reads whole, and the rest of the page is still capped", () => {
    const blocks = [para(-1), diagram("d1"), ...paras];
    const html = pageHtml(blocks, "Overview", { expand: ["d1"] });
    expect(expanded(html)).toBe(true);
    expect(html).toMatch(/Read on with after: "b\d+"/);
    // The capped read plus the diagram, not the 124K page.
    expect(html.length).toBeLessThan(cap + whole + 1_000);
  });

  test("expanding an album — which reads as a stub either way — leaves the cap alone", () => {
    const blocks = [album("a1"), ...paras];
    const html = pageHtml(blocks, "Overview", { expand: ["a1"] });
    expect(html).toBe(pageHtml(blocks, "Overview"));
    expect(html.length).toBeLessThan(cap + 1_000);
    expect(html).not.toContain("not in this part of the page");
  });

  test("a diagram past the cut says where to read it, and that read expands it", () => {
    const blocks = [...paras.slice(0, 100), diagram("d9"), ...paras.slice(100)];
    const first = pageHtml(blocks, "Overview", { expand: ["d9"] });
    expect(expanded(first)).toBe(false);
    expect(first).toContain('d9 is not in this part of the page, so it was not expanded. Read it with after: "b99"');
    const there = pageHtml(blocks, "Overview", { expand: ["d9"], after: "b99" });
    expect(expanded(there)).toBe(true);
    expect(there).not.toContain("not in this part of the page");
    expect(there.length).toBeLessThan(cap + whole + 1_000);
  });

  test("a diagram above an after read is pointed back to, and a first block needs no after", () => {
    const blocks = [diagram("d0"), ...paras];
    const html = pageHtml(blocks, "Overview", { expand: ["d0"], after: "b50" });
    expect(html).toContain('d0 is not in this part of the page, so it was not expanded. Read it with no after and expand: ["d0"]');
  });
});
