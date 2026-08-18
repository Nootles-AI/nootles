import { beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import type { AnyBlock } from "../projection";
import { redeemDrawnStubs, toDocHtml } from "./serialize";

// The collapse reads boards and scenes back through their own parsers, which
// reach for the platform DOMParser; linkedom stands in for it here.
beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = class {
    parseFromString(html: string) {
      return parseHTML(html).document;
    }
  };
});

/** A path node heavy enough to read as drawn: most of its bytes are `d`. */
function drawnScene(): string {
  const d =
    "M 0 0 " +
    Array.from({ length: 900 }, (_, i) => `L ${i} ${i % 180}`).join(" ") +
    " Z";
  return serializeScene({
    w: 320,
    h: 180,
    style: {},
    nodes: [
      {
        id: "v1",
        kind: "path",
        x: 0,
        y: 0,
        w: 320,
        h: 180,
        rot: 0,
        d,
        style: { fill: "#123456" },
        label: "",
        locked: false,
        hidden: false,
        attrs: {},
      },
    ],
    edges: [],
    attrs: {},
  });
}

function block(id: string, type: string, data: string): AnyBlock {
  return { id, type, props: { data }, content: undefined, children: [] } as unknown as AnyBlock;
}

describe("drawn stubs", () => {
  const scene = drawnScene();
  const boardData = serializeStoryboard({
    ratio: "16:9",
    shots: [
      { scene, note: "The chase begins." },
      { scene: "", note: "Quiet street." },
    ],
  });
  const board = block("B1", "storyboard", boardData);
  const canvas = block("C1", "canvas", scene);

  it("collapses a drawn shot to an addressed stub, undrawn shots untouched", () => {
    const full = toDocHtml([board]);
    const collapsed = toDocHtml([board], { collapseDrawn: true });
    expect(full).toContain("M 0 0");
    expect(collapsed).not.toContain("M 0 0");
    expect(collapsed).toContain('drawn="1 shapes"');
    expect(collapsed).toContain('at="B1:0"');
    expect(collapsed).toContain("Quiet street.");
  });

  it("leaves a board alone when its id is in expandDrawn", () => {
    const opened = toDocHtml([board], {
      collapseDrawn: true,
      expandDrawn: new Set(["B1"]),
    });
    expect(opened).toBe(toDocHtml([board]));
  });

  it("redeems a returned stub for the exact scene it stood for", () => {
    const collapsed = toDocHtml([board], { collapseDrawn: true });
    const redeemed = redeemDrawnStubs(collapsed, [board]);
    expect(redeemed.missing).toEqual([]);
    expect(parseStoryboard(redeemed.html).shots[0].scene).toBe(scene);
  });

  it("redeems a stub the model moved to another shot", () => {
    const collapsed = toDocHtml([board], { collapseDrawn: true });
    const stub = /<nt-diagram[^>]*\bat="B1:0"[^>]*><\/nt-diagram>/.exec(collapsed)![0];
    const model =
      `<nt-storyboard id="B1" ratio="16:9"><nt-shot><nt-note>Quiet street.</nt-note></nt-shot>` +
      `<nt-shot>${stub}<nt-note>The chase begins.</nt-note></nt-shot></nt-storyboard>`;
    const redeemed = redeemDrawnStubs(model, [board]);
    expect(redeemed.missing).toEqual([]);
    expect(parseStoryboard(redeemed.html).shots[1].scene).toBe(scene);
  });

  it("collapses and redeems a drawn canvas block byte for byte", () => {
    const full = toDocHtml([canvas]);
    const collapsed = toDocHtml([canvas], { collapseDrawn: true });
    expect(collapsed).toBe('<nt-diagram id="C1" drawn="1 shapes" at="C1"></nt-diagram>');
    expect(redeemDrawnStubs(collapsed, [canvas]).html).toBe(full);
  });

  it("reports an address that no longer resolves instead of guessing", () => {
    const gone = redeemDrawnStubs(
      '<nt-diagram drawn="1 shapes" at="gone:3"></nt-diagram>',
      [board],
    );
    expect(gone.missing).toEqual(["gone:3"]);
    expect(gone.html).toContain('at="gone:3"');
  });

  it("keeps a hand-built diagram inline — words are not a drawing", () => {
    const small = block(
      "C2",
      "canvas",
      serializeScene({
        w: 320,
        h: 180,
        style: {},
        nodes: [
          {
            id: "n1",
            kind: "rect",
            x: 40,
            y: 40,
            w: 120,
            h: 60,
            rot: 0,
            style: { background: "#f2f2f0" },
            label: "Start",
            locked: false,
            hidden: false,
            attrs: {},
          },
        ],
        edges: [],
        attrs: {},
      }),
    );
    expect(toDocHtml([small], { collapseDrawn: true })).toBe(toDocHtml([small]));
  });
});
