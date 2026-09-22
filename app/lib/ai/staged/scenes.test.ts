import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { isGroup, type SceneNode } from "@/app/components/editor/canvas/scene/types";
import { SCRIPTS } from "./scripts";
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

      it("keeps its shapes inside the frame it declares", () => {
        // A shape past the edge is not a parse error — it is a diagram with
        // something cut off, which is the kind of thing only a human notices,
        // and only on stage.
        const w = Number(/\bw="(\d+(?:\.\d+)?)"/.exec(html)?.[1] ?? 0);
        const h = Number(/\bh="(\d+(?:\.\d+)?)"/.exec(html)?.[1] ?? 0);
        if (!w || !h) return;
        for (const node of scene.nodes) {
          expect(node.x, `${id}: ${node.id} starts left of the frame`).toBeGreaterThanOrEqual(0);
          expect(node.y, `${id}: ${node.id} starts above the frame`).toBeGreaterThanOrEqual(0);
          expect(node.x + node.w, `${id}: ${node.id} runs off the right`).toBeLessThanOrEqual(w);
          expect(node.y + node.h, `${id}: ${node.id} runs off the bottom`).toBeLessThanOrEqual(h);
        }
      });
    });
  }
});
