import { describe, expect, test } from "vitest";
import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { SceneNode } from "@/app/components/editor/canvas/scene/types";
import { AI } from "../aiConfig";
import type { AnyBlock } from "../projection";
import { editEcho, pageHtml } from "./clientTools";

(globalThis as { DOMParser?: unknown }).DOMParser = class {
  parseFromString(html: string) {
    return parseHTML(html).document;
  }
};

const para = (id: string, text = `Paragraph ${id}. ${"words ".repeat(100)}`): AnyBlock =>
  ({
    id,
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  }) as unknown as AnyBlock;

function diagram(id: string, labels = 150, moved = 0): AnyBlock {
  const nodes: SceneNode[] = Array.from({ length: labels }, (_, i) => ({
    id: `s${i}`,
    kind: "rect",
    x: i * 10 + (i === 0 ? moved : 0),
    y: 0,
    w: 100,
    h: 40,
    rot: 0,
    label: `Box ${i}`,
    locked: false,
    hidden: false,
    attrs: {},
    style: { background: "#f4f4f4" },
  }));
  const data = serializeScene({ w: 1600, h: 400, style: {}, nodes, edges: [], attrs: {} });
  return { id, type: "canvas", props: { data }, content: undefined, children: [] } as unknown as AnyBlock;
}

const ids = (html: string) => [...html.matchAll(/<(?:p|nt-diagram) id="([^"]+)"/g)].map((m) => m[1]);

describe("edit_page's echo is the edit, not the page (NT-98)", () => {
  // 40 paragraphs of ~620 characters: the whole page is a 24K echo.
  const page = Array.from({ length: 40 }, (_, i) => para(`b${i}`));

  test("one rewritten block comes back with a neighbour either side and the rest counted", () => {
    const after = page.map((b) => (b.id === "b20" ? para("b20", "Rewritten.") : b));
    const echo = editEcho(page, after, "Overview", new Set(["b20"]));
    expect(echo.startsWith("<title>Overview</title>\n")).toBe(true);
    expect(ids(echo)).toEqual(["b19", "b20", "b21"]);
    expect(echo).toContain("<!-- 19 unchanged blocks before these -->");
    expect(echo).toContain("<!-- 18 unchanged blocks after these -->");
    expect(echo).toContain("Rewritten.");
    // Against the whole-page echo it replaces.
    expect(echo.length * 10).toBeLessThan(pageHtml(after, "Overview").length);
  });

  test("new blocks show the ids the page minted for them, and two edits far apart are two runs", () => {
    const after = [...page.slice(0, 5), para("n1", "New one."), ...page.slice(5, 30), para("n2", "New two."), ...page.slice(30)];
    const echo = editEcho(page, after, "Overview", new Set());
    expect(ids(echo)).toEqual(["b4", "n1", "b5", "b29", "n2", "b30"]);
    expect(echo).toContain("<!-- 4 unchanged blocks before these -->");
    expect(echo).toContain("<!-- 23 unchanged blocks between -->");
    expect(echo).toContain("<!-- 9 unchanged blocks after these -->");
  });

  test("removed blocks are named, and the blocks they sat between are shown", () => {
    const after = page.filter((b) => b.id !== "b0" && b.id !== "b39");
    const echo = editEcho(page, after, "Overview", new Set());
    expect(echo).toContain("<!-- removed: b0, b39 -->");
    expect(ids(echo)).toEqual([]);
    expect(echo).toContain("<!-- 38 unchanged blocks on the page -->");
  });

  test("a diagram the model rewrote by id comes back whole, and one it added is a stub", () => {
    const before = [para("b0"), diagram("d1"), para("b1")];
    const after = [para("b0"), diagram("d1", 150, 5), para("b1"), diagram("d2"), para("b2", "Tail.")];
    const echo = editEcho(before, after, "Board", new Set(["d1"]));
    expect(echo).toContain('<nt-rect id="s149"');
    // d2 is a stub: the model never wrote its shapes, the writer did.
    expect(echo).toMatch(/<nt-diagram id="d2" at="d2" holds="150 shapes"/);
    expect(echo.match(/<nt-rect id="s149"/g)).toHaveLength(1);
    expect(echo).toContain("A diagram reads as a stub");
  });

  test("a diagram whose stub is unchanged but whose shapes moved still counts as touched", () => {
    const before = [para("b0"), diagram("d1"), para("b1"), para("b2"), para("b3")];
    const after = [para("b0"), diagram("d1", 150, 7), para("b1"), para("b2"), para("b3")];
    const echo = editEcho(before, after, "Board", new Set(["d1"]));
    expect(ids(echo)).toEqual(["b0", "d1", "b1"]);
    expect(echo).toContain("<!-- 2 unchanged blocks after these -->");
  });

  test("a rewrite of most of a long page is capped, and says where to read on", () => {
    const long = Array.from({ length: 120 }, (_, i) => para(`b${i}`));
    const after = long.map((b) => para(b.id, `Rewritten ${b.id}. ${"other ".repeat(100)}`));
    const echo = editEcho(long, after, "Overview", new Set());
    expect(echo.length).toBeLessThan(AI.chat.maxPageChars + 500);
    const next = /Read on with after: "(b\d+)"/.exec(echo)?.[1];
    expect(next).toBeDefined();
    expect(ids(echo).at(-1)).toBe(next);
  });

  test("an empty page after the edit says so", () => {
    const echo = editEcho([para("b0")], [], "Gone", new Set());
    expect(echo).toBe("<title>Gone</title>\n<!-- this page is empty -->\n<!-- removed: b0 -->");
  });
});
