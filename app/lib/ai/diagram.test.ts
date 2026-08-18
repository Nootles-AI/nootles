import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { diagramElement } from "./diagram";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";

const dom = (h: string) => parseHTML(h).document as unknown as Document;

describe("diagramElement salvage", () => {
  it("returns a whole element untouched", () => {
    const el = `<nt-diagram w="320" h="180">\n  <nt-rect id="a" x="0" y="0" w="10" h="10"></nt-rect>\n</nt-diagram>`;
    expect(diagramElement("noise " + el + " trailing")).toBe(el);
  });

  it("salvages a reply the token cap cut mid-shape", () => {
    const cut =
      `<nt-diagram w="320" h="180" style="background: #111">\n` +
      `  <nt-rect id="sky" x="0" y="0" w="320" h="120" style="background: #223"></nt-rect>\n` +
      `  <nt-path id="road" x="0" y="120" w="320" h="60" d="M 0 60 L 120 0 L 200 0 L 320 60 Z" style="fill: #333"></nt-path>\n` +
      `  <nt-path id="car" x="140" y="90" w="60" h="30" d="M 0 30 C 10 1`;
    const out = diagramElement(cut);
    expect(out.endsWith("</nt-diagram>")).toBe(true);
    const scene = parseScene(out, dom);
    // The whole shapes survive the cut; only the severed tail is lost.
    expect(scene.nodes.length).toBeGreaterThanOrEqual(2);
    expect(scene.w).toBe(320);
  });

  it("still refuses a reply with no diagram at all", () => {
    expect(diagramElement("I cannot draw that.")).toBe("");
  });
});
