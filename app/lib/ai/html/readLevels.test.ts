import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { SceneNode } from "@/app/components/editor/canvas/scene/types";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import type { AnyBlock } from "../projection";
import { redeemDrawnStubs, toDocHtml, toDocHtmlWithin } from "./serialize";

// At module level, not in beforeAll: the fixtures below are built as the
// suite is collected, and they read scenes back through the platform parser.
(globalThis as { DOMParser?: unknown }).DOMParser = class {
  parseFromString(html: string) {
    return parseHTML(html).document;
  }
};

const base = { x: 0, y: 0, w: 100, h: 40, rot: 0, label: "", locked: false, hidden: false, attrs: {} };
const PNG = `data:image/png;base64,${"A".repeat(400)}`;
const D = `M 0 0 ${Array.from({ length: 40 }, (_, i) => `L ${i} ${i % 7}`).join(" ")} Z`;

/** A screen the way a Figma paste writes one: styled, labelled, with icons and a picture. */
function screen(): string {
  const nodes: SceneNode[] = [
    {
      ...base,
      id: "g1",
      kind: "group",
      w: 400,
      h: 300,
      name: "Dashboard",
      attrs: { "data-figma-id": "158:774" },
      style: { background: "#132836", overflow: "hidden" },
      children: [
        { ...base, id: "r1", kind: "rect", style: { background: "#0a2130", "border-radius": "8px" }, label: "Saved <b>Deals</b>" },
        { ...base, id: "t1", kind: "text", y: 50, style: { "font-size": "19px", color: "#ffffff" }, label: "CashB" },
        { ...base, id: "p1", kind: "path", y: 100, w: 40, h: 7, d: D, attrs: { "data-figma-id": "158:776" }, style: { fill: "#ffffff" } },
        { ...base, id: "i1", kind: "image", y: 150, src: PNG, style: {} },
      ],
    },
  ];
  return serializeScene({
    w: 400,
    h: 300,
    style: { background: "#000000" },
    nodes,
    edges: [{ id: "e1", from: "r1", to: "t1", label: "", style: { stroke: "#fff" }, attrs: {} }],
    attrs: {},
  });
}

function block(id: string, type: string, data: string): AnyBlock {
  return { id, type, props: { data }, content: undefined, children: [] } as unknown as AnyBlock;
}

describe("a diagram reads in one of two states", () => {
  const canvas = block("C1", "canvas", screen());
  const full = toDocHtml([canvas]);
  const read = { collapseDiagrams: true } as const;

  it("unasked, it is a stub carrying every word on it", () => {
    expect(toDocHtml([canvas], read)).toBe(
      '<nt-diagram id="C1" at="C1" holds="5 shapes" text="Saved Deals · CashB"></nt-diagram>',
    );
  });

  it("expanded, it is the whole grammar as stored — paths, pictures, imports and all", () => {
    expect(toDocHtml([canvas], { ...read, expandDrawn: new Set(["C1"]) })).toBe(full);
  });

  it("an expanded read is never cut, whatever the budget", () => {
    expect(toDocHtmlWithin([canvas], 10, { ...read, expandDrawn: new Set(["C1"]) })).toEqual({ html: full, dropped: 0 });
    expect(toDocHtmlWithin([canvas], 10, read)).toEqual({ html: "", dropped: 1 });
  });

  it("a stub returned as given redeems byte for byte", () => {
    const back = redeemDrawnStubs(toDocHtml([canvas], read), [canvas]);
    expect(back.missing).toEqual([]);
    expect(back.html).toBe(full);
  });

  it("a stub with shapes inside keeps the diagram and appends them", () => {
    const back = redeemDrawnStubs(
      `<nt-diagram id="C1" at="C1" holds="5 shapes" text="…">\n  <nt-rect id="new" x="0" y="0" w="10" h="10"></nt-rect>\n</nt-diagram>`,
      [canvas],
    );
    expect(back.missing).toEqual([]);
    expect(back.html).toBe(full.replace(/\n<\/nt-diagram>$/, '\n  <nt-rect id="new" x="0" y="0" w="10" h="10"></nt-rect>\n</nt-diagram>'));
  });

  it("a storyboard's shots read as stubs by position, and the board expands whole", () => {
    const board = block(
      "B1",
      "storyboard",
      serializeStoryboard({
        ratio: "16:9",
        shots: [
          { scene: "", note: "Quiet street." },
          { scene: screen(), note: "The screen." },
        ],
      }),
    );
    const short = toDocHtml([board], read);
    expect(short).toContain('<nt-diagram at="B1:1" holds="5 shapes" text="Saved Deals · CashB"></nt-diagram>');
    expect(short).not.toContain("M 0 0");
    expect(parseStoryboard(redeemDrawnStubs(short, [board]).html)).toEqual(parseStoryboard(toDocHtml([board])));
    expect(toDocHtml([board], { ...read, expandDrawn: new Set(["B1"]) })).toBe(toDocHtml([board]));
  });

  it("the completion lanes' reads are untouched: a hand-built diagram stays inline", () => {
    expect(toDocHtml([canvas], { collapseDrawn: true })).toBe(full);
  });
});
