import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { booleanOps, clipperReady, derivedPath, flattenOp, loadClipper, operandsPath, withFrames } from "./boolean";
import { applyOps } from "./ops";
import { outlineOf } from "./outline";
import { parseScene } from "./parse";
import { sceneNodeSchema } from "./schema";
import { serializeScene } from "./serialize";
import { findNode, isGroup, type GroupNode, type Scene, type SceneNode } from "./types";

const parse = (html: string): Scene => parseScene(html, (h) => parseHTML(h).document as unknown as Document);

const node = (kind: SceneNode["kind"], id: string, x: number, y: number, w: number, h: number, extra: Partial<SceneNode> = {}): SceneNode =>
  ({ kind, id, x, y, w, h, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {}, ...extra }) as SceneNode;

const group = (id: string, children: SceneNode[], op: GroupNode["op"], extra: Partial<GroupNode> = {}): GroupNode =>
  ({ ...node("group", id, 0, 0, 200, 200), children, op, ...extra }) as GroupNode;

/** The rings of a `d` written by the clipper, as point lists. */
const ringsOf = (d: string) => d.split("M ").filter(Boolean).map((ring) => ring.replace(/Z\s*$/, "").trim().split(" L ").map((p) => p.split(" ").map(Number)));
const bounds = (d: string) => {
  const pts = ringsOf(d).flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

describe("outlineOf", () => {
  it("writes each closed kind in its own box", () => {
    expect(outlineOf(node("rect", "r", 0, 0, 100, 50))).toBe("M 0 0 L 100 0 L 100 50 L 0 50 Z");
    expect(outlineOf(node("rect", "r", 0, 0, 100, 50, { style: { "border-radius": "10px" } }))).toBe(
      "M 10 0 L 90 0 A 10 10 0 0 1 100 10 L 100 40 A 10 10 0 0 1 90 50 L 10 50 A 10 10 0 0 1 0 40 L 0 10 A 10 10 0 0 1 10 0 Z",
    );
    // A radius past half the box meets itself in the middle.
    expect(outlineOf(node("rect", "r", 0, 0, 100, 50, { style: { "border-radius": "80px" } }))).toContain("A 25 25");
    expect(outlineOf(node("ellipse", "e", 0, 0, 100, 50))).toBe("M 0 25 A 50 25 0 1 0 100 25 A 50 25 0 1 0 0 25 Z");
    expect(outlineOf({ ...node("polygon", "p", 0, 0, 100, 100), sides: 4 } as SceneNode)).toMatch(/^M 50 0 L 100 50 L 50 100 L 0 50 Z$/);
    expect(outlineOf({ ...node("path", "d", 0, 0, 10, 10), d: "M 0 0 L 10 10" } as SceneNode)).toBe("M 0 0 L 10 10");
    expect(outlineOf(node("text", "t", 0, 0, 10, 10))).toBeNull();
    expect(outlineOf(node("image", "i", 0, 0, 10, 10))).toBeNull();
  });
});

describe("derivedPath", () => {
  const a = node("rect", "a", 0, 0, 100, 100);
  const b = node("rect", "b", 50, 50, 100, 100);

  it("is null until the clipper has loaded, and the operands stand in", () => {
    expect(clipperReady()).toBe(false);
    expect(derivedPath(group("g", [a, b], "union"))).toBeNull();
    expect(operandsPath(group("g", [a, b], "union"))).toBe("M 0 0 L 100 0 L 100 100 L 0 100 Z M 50 50 L 150 50 L 150 150 L 50 150 Z");
  });

  describe("once loaded", () => {
    beforeAll(() => loadClipper());

    it("unites, subtracts, intersects and excludes two squares", () => {
      const union = derivedPath(group("g", [a, b], "union"))!;
      expect(ringsOf(union)).toHaveLength(1);
      expect(ringsOf(union)[0]).toHaveLength(8);
      expect(bounds(union)).toEqual({ x0: 0, y0: 0, x1: 150, y1: 150 });

      const subtract = derivedPath(group("g", [a, b], "subtract"))!;
      expect(ringsOf(subtract)[0]).toHaveLength(6);
      expect(bounds(subtract)).toEqual({ x0: 0, y0: 0, x1: 100, y1: 100 });

      const intersect = derivedPath(group("g", [a, b], "intersect"))!;
      expect(ringsOf(intersect)[0]).toHaveLength(4);
      expect(bounds(intersect)).toEqual({ x0: 50, y0: 50, x1: 100, y1: 100 });

      const exclude = derivedPath(group("g", [a, b], "exclude"))!;
      expect(ringsOf(exclude)).toHaveLength(2);
    });

    it("takes the rest from the first, whatever order the rest come in", () => {
      const c = node("rect", "c", -50, -50, 100, 100);
      const d = derivedPath(group("g", [a, b, c], "subtract"))!;
      expect(bounds(d)).toEqual({ x0: 0, y0: 0, x1: 100, y1: 100 });
      // Two corners cut away leave two squares touching at a point.
      expect(ringsOf(d).map((ring) => ring.length)).toEqual([4, 4]);
    });

    it("places a turned operand where the canvas draws it", () => {
      const tall = node("rect", "t", 0, 0, 100, 50, { rot: 90 });
      const d = derivedPath(group("g", [tall], "union"))!;
      expect(bounds(d)).toEqual({ x0: 25, y0: -25, x1: 75, y1: 75 });
    });

    it("reads a plain group as the union of what it holds, and skips the hidden", () => {
      const inner = { ...group("inner", [a, node("rect", "h", 300, 300, 10, 10, { hidden: true })], undefined), x: 10, y: 10 } as GroupNode;
      const d = derivedPath(group("g", [inner, b], "intersect"))!;
      expect(bounds(d)).toEqual({ x0: 50, y0: 50, x1: 110, y1: 110 });
    });

    it("keeps a ring's hole, and cuts nothing where nothing meets", () => {
      const ring = { ...node("path", "r", 0, 0, 100, 100), d: "M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z" } as SceneNode;
      const d = derivedPath(group("g", [ring], "union"))!;
      expect(ringsOf(d)).toHaveLength(2);
      expect(derivedPath(group("g", [a, node("rect", "far", 500, 500, 10, 10)], "intersect"))).toBe("");
    });

    it("previews a gesture: the moved operand's box, the rest untouched, a path stretched", () => {
      const tri = { ...node("path", "t", 0, 0, 10, 10), d: "M 0 0 L 10 0 L 0 10 Z" } as SceneNode;
      const g = group("g", [a, b, tri], "subtract");
      const live = withFrames(g, new Map([
        ["b", { id: "b", x: 80, y: 80, w: 100, h: 100, rot: 0 }],
        ["t", { id: "t", x: 0, y: 0, w: 20, h: 10, rot: 0 }],
      ]));
      expect(live.children[0]).toBe(a);
      expect(live.children[1]).toMatchObject({ x: 80, y: 80 });
      expect((live.children[2] as { d: string }).d).toBe("M 0 0 L 20 0 L 0 10 Z");
      expect(bounds(derivedPath(live)!)).toEqual({ x0: 0, y0: 0, x1: 100, y1: 100 });
      // A corner cut square, and the top-left corner cut on the diagonal.
      expect(ringsOf(derivedPath(live)!)[0]).toHaveLength(7);
      expect(withFrames(g, new Map())).toBe(g);
    });

    it("flattens in place: same id and slot, tight box, the turn honoured", () => {
      const g = { ...group("g", [a, b], "union"), x: 10, y: 20, rot: 90 } as GroupNode;
      const scene: Scene = { w: 400, h: 400, style: {}, nodes: [g, node("rect", "other", 0, 0, 10, 10)], edges: [{ id: "e1", from: "g", to: "other", label: "", style: {}, attrs: {} }], attrs: {} };
      const op = flattenOp(g)!;
      expect(op).toMatchObject({ type: "setPath", id: "g" });
      const next = applyOps(scene, [op]);
      const path = findNode(next, "g")!;
      expect(path.kind).toBe("path");
      expect(next.nodes[0]).toBe(path);
      expect(next.edges).toHaveLength(1);
      // The drawing spans 150 of the 200 box; turned about the box centre
      // (110, 120), the tight box's centre (85, 95) lands at (135, 95).
      expect([path.x, path.y, path.w, path.h, path.rot]).toEqual([60, 20, 150, 150, 90]);
      expect(bounds((path as { d: string }).d)).toEqual({ x0: 0, y0: 0, x1: 150, y1: 150 });
      expect(flattenOp(a)).toBeNull();
    });
  });
});

describe("the op through the grammar", () => {
  it("round-trips, reads an unknown value as a union, and passes the schema", () => {
    const html = [
      '<nt-diagram w="400" h="300">',
      '  <nt-group id="g" x="10" y="10" w="200" h="200" op="subtract" style="fill: #333">',
      '    <nt-rect id="a" x="0" y="0" w="100" h="100"></nt-rect>',
      '    <nt-ellipse id="b" x="50" y="50" w="100" h="100"></nt-ellipse>',
      "  </nt-group>",
      "</nt-diagram>",
    ].join("\n");
    const scene = parse(html);
    const g = findNode(scene, "g") as GroupNode;
    expect(g.op).toBe("subtract");
    expect(serializeScene(scene)).toBe(html);
    expect(sceneNodeSchema.safeParse(g).success).toBe(true);
    expect((findNode(parse(html.replace('op="subtract"', 'op="Merge"')), "g") as GroupNode).op).toBe("union");
    expect((findNode(parse(html.replace(' op="subtract"', "")), "g") as GroupNode).op).toBeUndefined();
  });

  it("makes a boolean of two shapes, wearing the bottom one's paint, and toggles a lone group", () => {
    const scene = parse(
      '<nt-diagram w="400" h="300">\n  <nt-rect id="a" x="0" y="0" w="200" h="200" style="background: #f00; border-radius: 8px"></nt-rect>\n  <nt-rect id="b" x="50" y="50" w="50" h="50" style="background: #00f"></nt-rect>\n</nt-diagram>',
    );
    const made = booleanOps(scene, scene.nodes, "subtract")!;
    const next = applyOps(scene, made.ops);
    const g = findNode(next, made.select[0]) as GroupNode;
    expect(isGroup(g) && g.op).toBe("subtract");
    // The enclosing rect is an operand, not an absorbed frame.
    expect(g.children.map((c) => c.id)).toEqual(["a", "b"]);
    expect(g.style).toEqual({ fill: "#f00" });

    const toggled = applyOps(next, booleanOps(next, [g], "union")!.ops);
    expect((findNode(toggled, g.id) as GroupNode).op).toBe("union");
    const cleared = applyOps(toggled, [{ type: "setShape", ids: [g.id], params: {} }]);
    expect((findNode(cleared, g.id) as GroupNode).op).toBeUndefined();
    expect(booleanOps(scene, [scene.nodes[0]], "union")).toBeNull();
  });
});
