import { describe, expect, it } from "vitest";
import { drawnEdges } from "../scene/edgePath";
import { applyOps } from "../scene/ops";
import type { Scene, SceneNode } from "../scene/types";
import { settleEdges } from "./liveEdges";

// The edge runtime has no CSSOM; ids here need no escaping.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };

const rect = (id: string, x: number, y: number): SceneNode =>
  ({ id, kind: "rect", x, y, w: 100, h: 60, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} }) as SceneNode;

const scene = (nodes: SceneNode[]): Scene => ({
  w: 0,
  h: 0,
  style: {},
  attrs: {},
  nodes,
  edges: [{ id: "e", from: "a", to: "m", label: "hi", style: {}, attrs: {} }],
});

/** A connector's elements as the edge layer renders them: a line, a hit strip and a label. */
function layer() {
  const attr = () => {
    const values = new Map<string, string>();
    return {
      writes: 0,
      getAttribute: (name: string) => values.get(name) ?? null,
      setAttribute(name: string, value: string) {
        this.writes += 1;
        values.set(name, value);
      },
    };
  };
  const paths = [attr(), attr()];
  const label = { style: { left: "", top: "" } };
  const root = {
    querySelectorAll: (selector: string) => (selector === '[data-edge="e"]' ? paths : []),
    querySelector: (selector: string) => (selector === '[data-edge-label="e"]' ? label : null),
  };
  return { root: root as unknown as ParentNode, paths, label };
}

describe("a connector's pixels have one owner", () => {
  // `m` in the left margin, as a wide band holds it.
  const margin = scene([rect("a", 80, 40), rect("m", -200, 200)]);

  it("is derived once per scene, for the renderer and the settle alike", () => {
    expect(drawnEdges(margin)).toBe(drawnEdges(margin));
    const moved = applyOps(margin, [{ type: "move", ids: ["m"], dx: 400, dy: 0 }]);
    expect(drawnEdges(moved)).not.toBe(drawnEdges(margin));
    expect(drawnEdges(moved)[0].d).not.toBe(drawnEdges(margin)[0].d);
  });

  it("puts back the committed scene's route over whatever a gesture drew live", () => {
    const { root, paths, label } = layer();
    // What a drag's last frame left: the route to where `m` was on screen.
    for (const path of paths) path.setAttribute("d", drawnEdges(margin)[0].d);
    const landed = applyOps(margin, [{ type: "move", ids: ["m"], dx: 400, dy: 0 }]);
    settleEdges(root, landed);
    const [drawn] = drawnEdges(landed);
    expect(paths.map((path) => path.getAttribute("d"))).toEqual([drawn.d, drawn.d]);
    expect(label.style).toEqual({ left: `${drawn.at.x}px`, top: `${drawn.at.y}px` });
  });

  it("writes nothing where the drawn path already is the route", () => {
    const { root, paths } = layer();
    const [drawn] = drawnEdges(margin);
    for (const path of paths) path.setAttribute("d", drawn.d);
    settleEdges(root, margin);
    expect(paths.map((path) => path.writes)).toEqual([1, 1]);
  });

  it("depends on the scene alone, never on where the band is placed", () => {
    // The same scene settles to the same pixels whatever placement the band
    // has — scene px, inside the transformed layer.
    const first = layer();
    const second = layer();
    settleEdges(first.root, margin);
    settleEdges(second.root, { ...margin, wide: true });
    expect(first.paths[0].getAttribute("d")).toBe(second.paths[0].getAttribute("d"));
  });
});
