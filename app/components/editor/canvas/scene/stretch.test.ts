import { parseHTML } from "linkedom";
import { beforeAll, describe, expect, it } from "vitest";
import { laidOutScene } from "./autoLayout";
import { derivedPath, loadClipper } from "./boolean";
import { applyOps, reflowHugs } from "./ops";
import { parseScene } from "./parse";
import { findNode, isGroup, type GroupNode, type NodeFrame, type PathNode, type Scene } from "./types";

const parse = (html: string): Scene =>
  reflowHugs(parseScene(html, (h) => parseHTML(h).document as unknown as Document));

const diagram = (body: string) => parse(`<nt-diagram w="800" h="600">${body}</nt-diagram>`);

const resize = (scene: Scene, ...frames: NodeFrame[]) => applyOps(scene, [{ type: "resize", frames }]);

const box = (scene: Scene, id: string) => {
  const node = findNode(scene, id)!;
  return [node.x, node.y, node.w, node.h].map((n) => Math.round(n * 1000) / 1000);
};

const PLAIN = `
  <nt-group id="g" x="200" y="120" w="200" h="120">
    <nt-rect id="a" x="0" y="0" w="80" h="60" style="border: 2px solid #111; border-radius: 8px; font-size: 13px"></nt-rect>
    <nt-rect id="b" x="120" y="60" w="80" h="60"></nt-rect>
  </nt-group>`;

describe("resizing a plain group", () => {
  it("stretches every child with it, each axis by its own factor", () => {
    const next = resize(diagram(PLAIN), { id: "g", x: 200, y: 120, w: 300, h: 180 });
    expect(box(next, "g")).toEqual([200, 120, 300, 180]);
    expect(box(next, "a")).toEqual([0, 0, 120, 90]);
    expect(box(next, "b")).toEqual([180, 90, 120, 90]);
  });

  it("leaves strokes, radii and type as authored — the Scale tool's job, not a resize's", () => {
    const scene = diagram(PLAIN);
    const next = resize(scene, { id: "g", x: 200, y: 120, w: 400, h: 240 });
    expect(findNode(next, "a")!.style).toBe(findNode(scene, "a")!.style);
    const scaled = applyOps(scene, [{ type: "scale", ids: ["g"], k: 2, anchor: { x: 200, y: 120 } }]);
    expect(findNode(scaled, "a")!.style["border"]).toBe("4px solid #111");
  });

  it("stretches one axis from an edge handle", () => {
    const next = resize(diagram(PLAIN), { id: "g", x: 200, y: 120, w: 250, h: 120 });
    expect(box(next, "a")).toEqual([0, 0, 100, 60]);
    expect(box(next, "b")).toEqual([150, 60, 100, 60]);
  });

  it("scales evenly under an aspect-locked frame", () => {
    const next = resize(diagram(PLAIN), { id: "g", x: 200, y: 120, w: 300, h: 180 });
    const a = findNode(next, "a")!;
    expect(a.w / a.h).toBeCloseTo(80 / 60);
  });

  it("from the centre, keeps each child where it sits in the box", () => {
    const next = resize(diagram(PLAIN), { id: "g", x: 150, y: 90, w: 300, h: 180 });
    expect(box(next, "g")).toEqual([150, 90, 300, 180]);
    expect(box(next, "a")).toEqual([0, 0, 120, 90]);
    expect(box(next, "b")).toEqual([180, 90, 120, 90]);
  });

  it("moved without a change of size, leaves the children as they were", () => {
    const scene = diagram(PLAIN);
    const next = resize(scene, { id: "g", x: 10, y: 10, w: 200, h: 120 });
    expect((findNode(next, "g") as GroupNode).children).toBe((findNode(scene, "g") as GroupNode).children);
  });

  it("scales through a nested group", () => {
    const scene = diagram(`
      <nt-group id="o" x="0" y="0" w="200" h="120">
        <nt-group id="i" x="0" y="0" w="120" h="80">
          <nt-rect id="na" x="0" y="0" w="50" h="40"></nt-rect>
          <nt-rect id="nb" x="70" y="40" w="50" h="40"></nt-rect>
        </nt-group>
        <nt-rect id="nc" x="150" y="70" w="50" h="50"></nt-rect>
      </nt-group>`);
    const next = resize(scene, { id: "o", x: 0, y: 0, w: 400, h: 180 });
    expect(box(next, "i")).toEqual([0, 0, 240, 120]);
    expect(box(next, "na")).toEqual([0, 0, 100, 60]);
    expect(box(next, "nb")).toEqual([140, 60, 100, 60]);
    expect(box(next, "nc")).toEqual([300, 105, 100, 75]);
  });

  it("stretches a path child's drawing with its box", () => {
    const scene = diagram(`
      <nt-group id="g" x="0" y="0" w="100" h="100">
        <nt-path id="p" x="0" y="0" w="100" h="100" d="M 0 0 L 100 100"></nt-path>
      </nt-group>`);
    const next = resize(scene, { id: "g", x: 0, y: 0, w: 200, h: 50 });
    expect((findNode(next, "p") as PathNode).d).toBe("M 0 0 L 200 50");
  });

  it("keeps a rotated child's angle, lands its centre, and grows each side along its own direction", () => {
    const scene = diagram(`
      <nt-group id="g" x="0" y="0" w="200" h="200">
        <nt-rect id="q" x="50" y="80" w="100" h="40" rot="90"></nt-rect>
        <nt-rect id="t" x="20" y="30" w="100" h="60" rot="30"></nt-rect>
      </nt-group>`);
    const next = resize(scene, { id: "g", x: 0, y: 0, w: 400, h: 200 });
    // At 90° the child's width runs down the group: an x-stretch lengthens its height.
    const q = findNode(next, "q")!;
    expect(q.rot).toBe(90);
    expect([q.w, q.h]).toEqual([100, 80]);
    expect([q.x + q.w / 2, q.y + q.h / 2]).toEqual([200, 100]);
    // At 30°: |S·u| for each side's direction u, the centre stretched as a point.
    const t = findNode(next, "t")!;
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    expect(t.rot).toBe(30);
    expect(t.w).toBeCloseTo(100 * Math.hypot(2 * c, s));
    expect(t.h).toBeCloseTo(60 * Math.hypot(2 * s, c));
    expect(t.x + t.w / 2).toBeCloseTo(140);
    expect(t.y + t.h / 2).toBeCloseTo(60);
  });

  it("is exact at every angle when the stretch is even", () => {
    const scene = diagram(`
      <nt-group id="g" x="0" y="0" w="200" h="200">
        <nt-rect id="t" x="20" y="30" w="100" h="60" rot="30"></nt-rect>
      </nt-group>`);
    const next = resize(scene, { id: "g", x: 0, y: 0, w: 300, h: 300 });
    expect(box(next, "t")).toEqual([30, 45, 150, 90]);
  });

  it("leaves an axis that sizes itself at its size, moving only its place", () => {
    const scene = diagram(`
      <nt-group id="g" x="0" y="0" w="200" h="100">
        <nt-text id="t" x="100" y="50" w="60" h="20" style="width: max-content">Hi</nt-text>
      </nt-group>`);
    const next = resize(scene, { id: "g", x: 0, y: 0, w: 400, h: 200 });
    expect(box(next, "t")).toEqual([200, 100, 60, 40]);
    expect(findNode(next, "t")!.style.width).toBe("max-content");
  });

  it("lets a frame for a descendant in the same op say where that one lands", () => {
    const next = resize(
      diagram(PLAIN),
      { id: "g", x: 200, y: 120, w: 400, h: 240 },
      { id: "b", x: 10, y: 10, w: 20, h: 20 },
    );
    expect(box(next, "a")).toEqual([0, 0, 160, 120]);
    expect(box(next, "b")).toEqual([10, 10, 20, 20]);
  });
});

const FLEX = `
  <nt-group id="fl" x="200" y="120" w="210" h="100" style="display: flex; gap: 10px; padding: 10px; width: fit-content">
    <nt-rect id="fa" w="90" h="80"></nt-rect>
    <nt-rect id="fb" w="90" h="80"></nt-rect>
  </nt-group>`;

describe("resizing an auto-layout group", () => {
  it("sets its box, turning a hug fixed, and re-flows the children without scaling them", () => {
    const scene = diagram(FLEX);
    expect(box(scene, "fl")).toEqual([200, 120, 210, 100]);
    const next = resize(scene, { id: "fl", x: 200, y: 120, w: 400, h: 150 });
    expect(box(next, "fl")).toEqual([200, 120, 400, 150]);
    expect(findNode(next, "fl")!.style.width).toBeUndefined();
    expect(box(next, "fa")).toEqual(box(scene, "fa"));
    expect(box(next, "fb")).toEqual(box(scene, "fb"));
  });

  it("fills a stretched child across the new room, and keeps a fixed one's size", () => {
    const scene = diagram(`
      <nt-group id="fl" x="0" y="0" w="210" h="100" style="display: flex; gap: 10px; padding: 10px; align-items: stretch; justify-content: center">
        <nt-rect id="fa" w="90" h="80"></nt-rect>
        <nt-rect id="fb" w="90" h="80"></nt-rect>
      </nt-group>`);
    const laid = laidOutScene(resize(scene, { id: "fl", x: 0, y: 0, w: 410, h: 200 }));
    expect(box(laid, "fa")).toEqual([110, 10, 90, 180]);
    expect(box(laid, "fb")).toEqual([210, 10, 90, 180]);
  });

  it("inside a plain group, takes the stretch as a box and re-flows rather than scales", () => {
    const scene = diagram(`
      <nt-group id="g" x="0" y="0" w="210" h="100">${FLEX.replace('x="200" y="120"', 'x="0" y="0"').replace("; width: fit-content", "")}</nt-group>`);
    const next = resize(scene, { id: "g", x: 0, y: 0, w: 420, h: 200 });
    expect(box(next, "fl")).toEqual([0, 0, 420, 200]);
    expect(box(next, "fa")).toEqual(box(scene, "fa"));
  });

  it("inside a plain group, keeps a hugging axis at the size its contents give it", () => {
    const scene = diagram(`<nt-group id="g" x="0" y="0" w="420" h="100">${FLEX.replace('x="200" y="120"', 'x="0" y="0"')}</nt-group>`);
    const next = resize(scene, { id: "g", x: 0, y: 0, w: 840, h: 200 });
    expect(box(next, "fl")).toEqual([0, 0, 210, 200]);
    expect(findNode(next, "fl")!.style.width).toBe("fit-content");
  });
});

describe("resizing a boolean", () => {
  beforeAll(() => loadClipper());

  const UNION = `
    <nt-group id="un" x="200" y="120" w="200" h="120" op="union">
      <nt-rect id="ua" x="0" y="0" w="130" h="90"></nt-rect>
      <nt-ellipse id="ub" x="70" y="30" w="130" h="90"></nt-ellipse>
    </nt-group>`;

  it("stretches its operands, so the cut lands as the stretched preview drew it", () => {
    const scene = diagram(UNION);
    const next = resize(scene, { id: "un", x: 200, y: 120, w: 300, h: 60 });
    expect(box(next, "ua")).toEqual([0, 0, 195, 45]);
    expect(box(next, "ub")).toEqual([105, 15, 195, 45]);
    const before = derivedPath(findNode(scene, "un") as GroupNode)!;
    const after = derivedPath(findNode(next, "un") as GroupNode)!;
    const stretched = before.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x, y) => `${Number(x) * 1.5} ${Number(y) * 0.5}`);
    const points = (d: string) => (d.match(/-?[\d.]+/g) ?? []).map(Number);
    const want = points(stretched);
    const got = points(after);
    expect(got.length).toBe(want.length);
    got.forEach((n, i) => expect(n).toBeCloseTo(want[i], 1));
  });

  it("is what the renderer reads — the group is still a boolean over the same operands", () => {
    const next = resize(diagram(UNION), { id: "un", x: 200, y: 120, w: 300, h: 60 });
    const group = findNode(next, "un")!;
    expect(isGroup(group) && group.op).toBe("union");
    expect((group as GroupNode).children.map((c) => c.id)).toEqual(["ua", "ub"]);
  });
});
