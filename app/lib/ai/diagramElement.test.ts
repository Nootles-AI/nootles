import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { diagramElement } from "./diagramElement";
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

  it("strips the plan comment the reply now opens with", () => {
    const el = `<nt-diagram w="320" h="180">\n  <nt-rect id="a" x="0" y="0" w="10" h="10"></nt-rect>\n</nt-diagram>`;
    const reply = `<!-- plan\nscene: a box\nparts: just the box\nlayout: 0 0 10x10 -->\n${el}`;
    expect(diagramElement(reply)).toBe(el);
  });

  it("refuses a reply the cap cut inside the plan itself", () => {
    expect(diagramElement("<!-- plan\nscene: a fox, a for")).toBe("");
  });

  it("keeps only whole shapes when the first is cut mid-label", () => {
    const cut = `<nt-diagram w="320" h="180">\n  <nt-rect id="a" x="0" y="0" w="10" h="10">Order rec`;
    const out = diagramElement(cut);
    expect(out).toBe(`<nt-diagram w="320" h="180">\n</nt-diagram>`);
    expect(parseScene(out, dom).nodes).toHaveLength(0);
  });

  it("drops a shape cut mid-label after whole ones, and the fence before", () => {
    const cut =
      "```html\n" +
      `<nt-diagram w="320" h="180">\n` +
      `  <nt-rect id="a" x="0" y="0" w="10" h="10">Order received</nt-rect>\n` +
      `  <nt-rect id="b" x="0" y="20" w="10" h="10">Pack and sh`;
    const scene = parseScene(diagramElement(cut), dom);
    expect(scene.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("refuses a reply cut inside the diagram's own opening tag", () => {
    expect(diagramElement('Here it is: <nt-diagram w="32')).toBe("");
  });
});
