import { DOMParser } from "linkedom";
import { describe, expect, test } from "vitest";
import { nodeBounds, unionBounds } from "./geometry";
import { applyOps } from "./ops";
import { parseScene } from "./parse";
import { serializeScene } from "./serialize";
import type { FlipAxis, GroupNode, Scene, SceneNode } from "./types";

const base = { rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} };

const rect = (id: string, x: number, y: number, w = 100, h = 60, over: Partial<SceneNode> = {}): SceneNode =>
  ({ ...base, id, kind: "rect", x, y, w, h, ...over }) as SceneNode;

const scene = (nodes: SceneNode[], edges: Scene["edges"] = []): Scene => ({
  w: 0,
  h: 0,
  style: {},
  nodes,
  edges,
  attrs: {},
});

const flip = (s: Scene, ids: string[], axis: FlipAxis) => applyOps(s, [{ type: "flip", ids, axis }]);
const at = (s: Scene, id: string) => s.nodes.find((node) => node.id === id)!;
const bounds = (s: Scene, ids: string[]) => unionBounds(ids.map((id) => ({ ...nodeBounds(at(s, id)), rot: 0 })));

describe("flip", () => {
  test("a selection mirrors about its own centre, its bounds unchanged", () => {
    const s = scene([rect("a", 0, 0, 100, 60), rect("b", 300, 100, 50, 50)]);
    const x = flip(s, ["a", "b"], "x");
    expect(at(x, "a").x).toBe(250);
    expect(at(x, "b").x).toBe(0);
    expect(at(x, "a").y).toBe(0);
    expect(bounds(x, ["a", "b"])).toEqual(bounds(s, ["a", "b"]));

    const y = flip(s, ["a", "b"], "y");
    expect(at(y, "a").y).toBe(90);
    expect(at(y, "b").y).toBe(0);
    expect(bounds(y, ["a", "b"])).toEqual(bounds(s, ["a", "b"]));
  });

  test("a lone shape flips in place, and rotation is negated", () => {
    const s = scene([rect("a", 40, 20, 100, 60, { rot: 30 })]);
    const x = at(flip(s, ["a"], "x"), "a");
    expect({ x: x.x, y: x.y, rot: x.rot }).toEqual({ x: 40, y: 20, rot: -30 });
    expect(at(flip(s, ["a"], "y"), "a").rot).toBe(-30);
  });

  test("a rotated selection keeps its visible bounds", () => {
    const s = scene([rect("a", 0, 0, 100, 40, { rot: 25 }), rect("b", 200, 80, 60, 60, { rot: -10 })]);
    for (const axis of ["x", "y"] as const) {
      const out = bounds(flip(s, ["a", "b"], axis), ["a", "b"]);
      const was = bounds(s, ["a", "b"]);
      expect(out.x).toBeCloseTo(was.x);
      expect(out.y).toBeCloseTo(was.y);
      expect(out.w).toBeCloseTo(was.w);
      expect(out.h).toBeCloseTo(was.h);
    }
  });

  test("a path's data mirrors inside its box, exactly", () => {
    const path = { ...base, id: "p", kind: "path", x: 10, y: 10, w: 100, h: 50, d: "M 0 0 L 100 20 C 80 30 60 40 20 50" } as SceneNode;
    const x = at(flip(scene([path]), ["p"], "x"), "p") as Extract<SceneNode, { kind: "path" }>;
    expect(x.d).toBe("M 100 0 L 0 20 C 20 30 40 40 80 50");
    const y = at(flip(scene([path]), ["p"], "y"), "p") as Extract<SceneNode, { kind: "path" }>;
    expect(y.d).toBe("M 0 50 L 100 30 C 80 20 60 10 20 0");
  });

  test("an arc turns with the mirror", () => {
    const pie = { ...base, id: "e", kind: "ellipse", x: 0, y: 0, w: 80, h: 80, start: 30, sweep: 90 } as SceneNode;
    expect((at(flip(scene([pie]), ["e"], "x"), "e") as { start?: number }).start).toBe(240);
    expect((at(flip(scene([pie]), ["e"], "y"), "e") as { start?: number }).start).toBe(60);
    const plain = { ...base, id: "e", kind: "ellipse", x: 0, y: 0, w: 80, h: 80 } as SceneNode;
    expect("start" in at(flip(scene([plain]), ["e"], "x"), "e")).toBe(false);
  });

  test("an odd polygon takes the half turn top to bottom, an even one the mirror", () => {
    const tri = { ...base, id: "t", kind: "polygon", x: 0, y: 0, w: 60, h: 60, sides: 3, rot: 10 } as SceneNode;
    expect(at(flip(scene([tri]), ["t"], "y"), "t").rot).toBe(170);
    expect(at(flip(scene([tri]), ["t"], "x"), "t").rot).toBe(-10);
    const hex = { ...tri, sides: 6 } as SceneNode;
    expect(at(flip(scene([hex]), ["t"], "y"), "t").rot).toBe(-10);
  });

  test("a group flips its children in its own frame, all the way down", () => {
    const inner: GroupNode = {
      ...base,
      id: "g2",
      kind: "group",
      x: 100,
      y: 0,
      w: 100,
      h: 100,
      children: [rect("c", 0, 0, 20, 20, { rot: 15 })],
    };
    const group: GroupNode = {
      ...base,
      id: "g",
      kind: "group",
      x: 50,
      y: 50,
      w: 200,
      h: 100,
      children: [rect("a", 0, 0, 40, 40), inner],
    };
    const out = at(flip(scene([group]), ["g"], "x"), "g") as GroupNode;
    expect(out.x).toBe(50);
    expect(out.children[0].x).toBe(160);
    const g2 = out.children[1] as GroupNode;
    expect(g2.x).toBe(0);
    expect(g2.children[0].x).toBe(80);
    expect(g2.children[0].rot).toBe(-15);
  });

  test("an auto-layout group leaves its children's places to the layout", () => {
    const row: GroupNode = {
      ...base,
      id: "g",
      kind: "group",
      x: 0,
      y: 0,
      w: 200,
      h: 60,
      style: { display: "flex" },
      children: [rect("a", 0, 0, 60, 60, { rot: 20 }), rect("b", 80, 0, 60, 60)],
    };
    const out = at(flip(scene([row]), ["g"], "x"), "g") as GroupNode;
    expect(out.children.map((c) => c.x)).toEqual([0, 80]);
    expect(out.children[0].rot).toBe(-20);
  });

  test("labels are left alone: the box moves, the words still read", () => {
    const s = scene([rect("a", 0, 0, 100, 60, { label: "Hello" }), rect("b", 200, 0, 100, 60)]);
    const out = flip(s, ["a", "b"], "x");
    expect(at(out, "a").label).toBe("Hello");
    expect(at(out, "a").style).toEqual({});
    expect(at(out, "a").x).toBe(200);
  });

  test("twice is the identity, for every kind", () => {
    const html =
      `<nt-diagram h="400">` +
      `<nt-rect id="a" x="10" y="20" w="100" h="60" rot="30">Label</nt-rect>` +
      `<nt-polygon id="t" x="150" y="40" w="60" h="60" sides="5" rot="12"></nt-polygon>` +
      `<nt-ellipse id="e" x="240" y="10" w="80" h="80" start="30" sweep="90"></nt-ellipse>` +
      `<nt-path id="p" x="20" y="120" w="100" h="50" d="M 0 0 L 100 20 C 80 30 60 40 20 50"></nt-path>` +
      `<nt-group id="g" x="200" y="150" w="120" h="80" rot="-20">` +
      `<nt-rect id="c" x="10" y="10" w="30" h="30"></nt-rect>` +
      `<nt-rect id="d" x="60" y="30" w="40" h="40" rot="45"></nt-rect>` +
      `</nt-group>` +
      `<nt-edge id="e1" from="a" to="t"></nt-edge>` +
      `</nt-diagram>`;
    const s = parseScene(html, (h) => new DOMParser().parseFromString(h, "text/html") as unknown as Document);
    const ids = ["a", "t", "e", "p", "g"];
    for (const axis of ["x", "y"] as const) {
      const back = flip(flip(s, ids, axis), ids, axis);
      expect(serializeScene(back)).toBe(serializeScene(s));
    }
  });

  test("connectors are untouched — they are drawn from their shapes", () => {
    const s = scene([rect("a", 0, 0), rect("b", 200, 0)], [
      { id: "e1", from: "a", to: "b", label: "", style: {}, attrs: {} },
    ]);
    expect(flip(s, ["a", "b"], "x").edges).toBe(s.edges);
  });

  test("unknown ids leave the scene as it was", () => {
    const s = scene([rect("a", 0, 0)]);
    expect(flip(s, ["nope"], "x")).toBe(s);
  });
});
