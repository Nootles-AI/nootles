import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { adoptScene } from "@/app/components/editor/canvas/scene/adopt";
import {
  bandHeight,
  bandLeft,
  bandWidth,
  fitOps,
  fitToBand,
} from "@/app/components/editor/canvas/scene/band";
import { parseFragment, parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { isGroup, type SceneNode } from "@/app/components/editor/canvas/scene/types";
import { POWER_PATH } from "./scenes";
import { SCRIPTS } from "./scripts";
import { C09 } from "./scripts/c09";
import type { StageContext } from "./types";

/**
 * Every canned diagram, through the canvas's own parser.
 *
 * `parseDocHtml` only proves a payload is a document. It says nothing about
 * whether the canvas can read the shapes inside it — an edge naming an id that
 * does not exist, a polygon missing `sides`, a shape parked outside the frame
 * are all valid HTML and a broken diagram. This is the nearest thing to
 * rendering that can be done without a browser, and the round trip
 * `serialize(parse(html)) === html` is a contract the AI layer edits diagrams
 * through, so a payload that does not satisfy it is one the agent cannot
 * reliably edit afterwards — which is exactly what C-09 and C-10 do.
 */

const dom = (html: string) => parseHTML(html).document as unknown as Document;

/** Resolvers want a live context; these payloads only need the open page. */
const ctx: StageContext = {
  projectId: "p1",
  pageId: "pg_open",
  said: "",
  results: [],
  pages: [{ pageId: "pg_open", title: "ICD" }],
};

/** Every `<nt-diagram>` a script writes, with the script that writes it. */
function diagrams(): { id: string; html: string }[] {
  const out: { id: string; html: string }[] = [];
  for (const script of SCRIPTS) {
    for (const step of script.steps) {
      for (const call of step.call ?? []) {
        if (call.tool !== "edit_page") continue;
        const input =
          typeof call.input === "function"
            ? (call.input as (c: StageContext) => { html?: string } | null)(ctx)
            : (call.input as { html?: string });
        if (!input?.html) continue;
        for (const found of input.html.matchAll(
          /<nt-diagram[\s\S]*?<\/nt-diagram\s*>/gi,
        )) {
          out.push({ id: script.id, html: found[0] });
        }
      }
    }
  }
  return out;
}

/** Every node in the tree, groups flattened. */
function flatten(nodes: SceneNode[]): SceneNode[] {
  return nodes.flatMap((node) =>
    isGroup(node) ? [node, ...flatten(node.children)] : [node],
  );
}

describe("the canned diagrams, read by the canvas", () => {
  const all = diagrams();

  it("there are diagrams to check", () => {
    // Guards the harness itself: a resolver change that quietly stopped
    // returning HTML would otherwise make every test below vacuously pass.
    expect(all.length).toBeGreaterThanOrEqual(5);
  });

  for (const { id, html } of all) {
    describe(id, () => {
      const scene = parseScene(html, dom);
      const nodes = flatten(scene.nodes);

      it("parses into shapes", () => {
        expect(nodes.length, "no shapes came out").toBeGreaterThan(0);
      });

      it("survives the round trip the agent edits through", () => {
        expect(serializeScene(parseScene(html, dom))).toBe(
          serializeScene(parseScene(serializeScene(parseScene(html, dom)), dom)),
        );
      });

      it("gives every shape a unique id", () => {
        const ids = nodes.map((n) => n.id);
        const seen = new Set(ids);
        expect(seen.size, `duplicate id in ${id}`).toBe(ids.length);
      });

      it("only joins shapes that exist", () => {
        const ids = new Set(nodes.map((n) => n.id));
        for (const edge of scene.edges) {
          expect(ids.has(edge.from), `${id}: edge ${edge.id} from ${edge.from}`).toBe(true);
          expect(ids.has(edge.to), `${id}: edge ${edge.id} to ${edge.to}`).toBe(true);
        }
      });

      it("states a band root: a height, never a width", () => {
        const root = /<nt-diagram\b[^>]*>/.exec(html)![0];
        expect(root, `${id}: a band's width is the page's`).not.toMatch(/\sw="/);
        expect(root, `${id}: no height stated`).toMatch(/\sh="\d+"/);
      });

      it("lands inside its band once the compile seam has fitted it", () => {
        // A shape past the edge is not a parse error — it is a diagram with
        // something cut off, which is the kind of thing only a human notices,
        // and only on stage. The seam scales what does not fit, so this reads
        // the diagram as it will be stored.
        const fitted = fitToBand(adoptScene(parseFragment(html, dom).scene));
        const left = bandLeft(fitted);
        const right = left + bandWidth(fitted);
        const slack = 1e-6;
        for (const node of fitted.nodes) {
          expect(node.x, `${id}: ${node.id} starts left of the band`).toBeGreaterThanOrEqual(left - slack);
          expect(node.y, `${id}: ${node.id} starts above the band`).toBeGreaterThanOrEqual(0);
          expect(node.x + node.w, `${id}: ${node.id} runs off the right`).toBeLessThanOrEqual(right + slack);
          expect(node.y + node.h, `${id}: ${node.id} runs off the bottom`).toBeLessThanOrEqual(bandHeight(fitted));
        }
      });

      it("is authored inside its band — only a board wider than a wide one is scaled", () => {
        const scaled = fitOps(adoptScene(parseFragment(html, dom).scene)).some((op) => op.type === "scale");
        expect(scaled, `${id}: the fit scaled it`).toBe(id === "C-12");
      });
    });
  }
});

describe("C-09's retry, spliced into the board as it reads", () => {
  it("sits under the gate driver it loops with, inside the band", () => {
    // What C-09 is answering: the power path read in full, with the width a
    // read states.
    const read = serializeScene({ ...parseScene(POWER_PATH, dom), id: "b7" }, { readWidth: true });
    const answered: StageContext = { ...ctx, results: [{ toolName: "read_open_page", output: read }] };
    const call = C09.steps.flatMap((step) => step.call ?? []).find((c) => c.tool === "edit_page")!;
    const input = (call.input as (c: StageContext) => { html: string } | null)(answered);
    const scene = fitToBand(adoptScene(parseFragment(input!.html, dom).scene));
    const node = (id: string) => scene.nodes.find((n) => n.id === id)!;
    expect(node("pp-retry").x).toBe(node("pp-drv").x);
    expect(node("pp-retry").y).toBeGreaterThanOrEqual(node("pp-drv").y + node("pp-drv").h);
    for (const n of scene.nodes) {
      expect(n.x, n.id).toBeGreaterThanOrEqual(bandLeft(scene));
      expect(n.x + n.w, n.id).toBeLessThanOrEqual(bandLeft(scene) + bandWidth(scene));
    }
  });
});
