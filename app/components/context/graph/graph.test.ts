import { describe, expect, it } from "vitest";
import { Layout, startAt, type Body } from "./force";
import { buildGraph, neighbours, pageKey, PROJECT, sectionsOf, type GraphData } from "./model";

const page = (pageId: string, folderId: string | null = null) => ({
  pageId,
  docId: `doc-${pageId}`,
  title: pageId,
  icon: null,
  folderId,
  brief: "",
  digested: false,
  owner: null,
  updatedAt: 1,
});

const data: GraphData = {
  title: "Rover",
  folders: [
    { folderId: "specs", title: "Specs", parentId: null, icon: null },
    { folderId: "orphan", title: "Lost", parentId: "gone", icon: null },
  ],
  pages: [page("a"), page("b", "specs"), page("c", "specs")],
  mentions: [
    { from: "a", to: "b" },
    { from: "a", to: "b" },
    { from: "c", to: "a" },
  ],
  code: { repos: [], areas: [], concerns: [], rollups: [] },
};

describe("buildGraph", () => {
  it("hangs folders and pages off the project as the sidebar does", () => {
    const { nodes, edges } = buildGraph(data);
    expect(nodes.map((n) => n.id)).toEqual([PROJECT, "f:specs", "f:orphan", "p:a", "p:b", "p:c"]);
    const contains = edges.filter((e) => e.kind === "contains").map((e) => [e.source, e.target]);
    expect(contains).toContainEqual([PROJECT, "f:orphan"]);
    expect(contains).toContainEqual(["f:specs", "p:b"]);
    expect(contains).toContainEqual([PROJECT, "p:a"]);
  });

  it("draws each mention once", () => {
    const mentions = buildGraph(data).edges.filter((e) => e.kind === "mentions");
    expect(mentions.map((e) => [e.source, e.target])).toEqual([
      ["p:a", "p:b"],
      ["p:c", "p:a"],
    ]);
  });

  it("knows each node's neighbours both ways", () => {
    const near = neighbours(buildGraph(data).edges);
    expect([...near.get(pageKey("a"))!].sort()).toEqual(["p:b", "p:c", PROJECT]);
  });
});

describe("sectionsOf", () => {
  it("reads the outline off a templated summary", () => {
    expect(sectionsOf("Sections: Watchdog · Timing\nThe rover stops.")).toEqual([
      "Watchdog",
      "Timing",
    ]);
    expect(sectionsOf("The rover stops.")).toEqual([]);
  });
});

describe("Layout", () => {
  const graph = (n: number) => {
    const bodies: Body[] = [{ id: "hub", x: 0, y: 0, vx: 0, vy: 0, w: 140, h: 40, pinned: true }];
    for (let i = 0; i < n; i++) {
      const at = startAt(`n${i}`, i, n, bodies[0], undefined);
      bodies.push({ id: `n${i}`, ...at, vx: 0, vy: 0, w: 120, h: 32, pinned: false });
    }
    const springs = bodies.slice(1).map((_, i) => ({ a: 0, b: i + 1, length: 96, strength: 0.32 }));
    return new Layout(bodies, springs);
  };

  it("comes to rest with no two boxes overlapping", () => {
    const l = graph(40);
    l.run();
    expect(l.settled).toBe(true);
    const [, ...rest] = l.bodies;
    for (const [i, a] of rest.entries()) {
      for (const b of rest.slice(i + 1)) {
        const apart =
          Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 1 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 - 1;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("lays the same graph out the same way every time", () => {
    const one = graph(25);
    const two = graph(25);
    one.run();
    two.run();
    expect(two.bodies.map((b) => [b.x, b.y])).toEqual(one.bodies.map((b) => [b.x, b.y]));
  });

  it("never moves a pinned body", () => {
    const l = graph(12);
    l.run();
    expect([l.bodies[0].x, l.bodies[0].y]).toEqual([0, 0]);
  });
});
