import { afterEach, describe, expect, it } from "vitest";

import type { Scene, SceneNode } from "../scene/types";
import {
  boxLines,
  boxTargets,
  collectSnapScope,
  columnLines,
  createSnapper,
  getSnapTargets,
  setSnapEnabled,
  setSnapTarget,
  subscribe,
} from "./snapping";

const rect = (id: string, x: number, y: number, w = 100, h = 60): SceneNode =>
  ({
    id,
    kind: "rect",
    x,
    y,
    w,
    h,
    rot: 0,
    style: {},
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
  }) as SceneNode;

const band = (nodes: SceneNode[]): Scene => ({ w: 0, h: 400, style: {}, nodes, edges: [], attrs: {} });

const xs = (lines: readonly { axis: string; at: number }[]) =>
  lines.filter((l) => l.axis === "x").map((l) => l.at).sort((a, b) => a - b);

afterEach(() => {
  setSnapEnabled(true);
  setSnapTarget("shapes", true);
  setSnapTarget("column", true);
  setSnapTarget("diagrams", true);
});

describe("the column a band snaps to", () => {
  it("is the text's two edges and its centre", () => {
    const lines = columnLines(false, 300);
    expect(xs(lines)).toEqual([0, 360, 720]);
    expect(lines.every((l) => l.axis === "x" && l.from === 0 && l.to === 300)).toBe(true);
    expect(lines.find((l) => l.at === 360)?.kind).toBe("centre");
  });

  it("reaches the wide edges on a wide band", () => {
    expect(xs(columnLines(true, 300))).toEqual([-240, 0, 360, 720, 960]);
  });
});

describe("what a gesture may snap to", () => {
  const scene = band([rect("a", 0, 24), rect("b", 200, 24), rect("c", 400, 24)]);
  const moving = new Set(["a"]);

  it("is the other shapes, and nothing of the band's own box", () => {
    const scope = collectSnapScope(scene, moving);
    expect(xs(scope.lines)).toEqual([200, 250, 300, 400, 450, 500]);
    expect(scope.boxes).toHaveLength(2);
  });

  it("adds the column behind its own switch", () => {
    const column = columnLines(false, 400);
    expect(xs(collectSnapScope(scene, moving, { column }).lines)).toContain(720);
    setSnapTarget("column", false);
    expect(xs(collectSnapScope(scene, moving, { column }).lines)).not.toContain(720);
  });

  it("turns the shapes off, lines and gaps together", () => {
    setSnapTarget("shapes", false);
    const scope = collectSnapScope(scene, moving, { column: columnLines(false, 400) });
    expect(xs(scope.lines)).toEqual([0, 360, 720]);
    expect(scope.boxes).toEqual([]);
  });

  it("lines up with other diagrams' shapes but never measures a gap to them", () => {
    const foreign = boxLines({ x: 600, y: 500, w: 80, h: 40 });
    const scope = collectSnapScope(scene, moving, { foreign });
    expect(xs(scope.lines)).toContain(640);
    expect(scope.boxes).toHaveLength(2);
    setSnapTarget("diagrams", false);
    expect(xs(collectSnapScope(scene, moving, { foreign }).lines)).not.toContain(640);
  });

  it("keeps a shot's own frame as it always has, whatever the switches say", () => {
    setSnapTarget("column", false);
    setSnapTarget("diagrams", false);
    const shot = { ...scene, w: 320, h: 180 };
    const scope = collectSnapScope(shot, moving, { surface: { x: 0, y: 0, w: 320, h: 180 } });
    expect(xs(scope.lines)).toEqual(expect.arrayContaining([0, 160, 320]));
    expect(scope.lines.filter((l) => l.axis === "y").map((l) => l.at)).toEqual(
      expect.arrayContaining([0, 90, 180]),
    );
  });

  it("tells whoever mirrors the switches, with a new object each time", () => {
    let heard = 0;
    const off = subscribe(() => heard++);
    const before = getSnapTargets();
    setSnapTarget("diagrams", false);
    setSnapTarget("diagrams", false);
    off();
    expect(heard).toBe(1);
    expect(getSnapTargets()).not.toBe(before);
    expect(getSnapTargets().diagrams).toBe(false);
  });
});

describe("a snapper built from a band's scope", () => {
  it("pulls a shape's edge onto the column", () => {
    const moving = { x: 100, y: 24, w: 100, h: 60 };
    const snapper = createSnapper(
      collectSnapScope(band([rect("a", 100, 24)]), new Set(["a"]), { column: columnLines(false, 400) }),
      { moving },
    );
    // Right edge at 200 + 517 = 717: three px short of the column's edge.
    const out = snapper.snap(boxTargets(moving), { x: 517, y: 0 }, 1);
    expect(out.dx).toBe(520);
    expect(out.guides[0]).toMatchObject({ axis: "x", at: 720 });
  });
});
