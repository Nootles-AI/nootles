import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { WIDE_W } from "../scene/band";
import { emptyScene } from "../scene/migrate";
import { applyOps } from "../scene/ops";
import { parseScene, type ParseHtml } from "../scene/parse";
import type { Scene, SceneEdge, SceneNode } from "../scene/types";
import { diagramFromClipboard, isCanvasHtml, landFragment, pageClipboardHtml } from "./clipboard";

const parseHtml: ParseHtml = (h) => parseHTML(h).document as unknown as Document;

const rect = (id: string, x: number, y: number, w = 100, h = 60): SceneNode =>
  ({ id, kind: "rect", x, y, w, h, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} }) as SceneNode;

const edge = (id: string, from: string, to: string): SceneEdge =>
  ({ id, from, to, style: {}, label: "", attrs: {} }) as unknown as SceneEdge;

const scene = (nodes: SceneNode[], edges: SceneEdge[] = [], extra: Partial<Scene> = {}): Scene => ({
  ...emptyScene(),
  h: 200,
  nodes,
  edges,
  ...extra,
});

describe("isCanvasHtml", () => {
  it("knows the grammar's tags and nothing else", () => {
    expect(isCanvasHtml('<nt-diagram h="10"></nt-diagram>')).toBe(true);
    expect(isCanvasHtml('<nt-rect id="a"></nt-rect>')).toBe(true);
    expect(isCanvasHtml("<p>nt-rect</p>")).toBe(false);
  });
});

describe("pageClipboardHtml", () => {
  const top = scene([rect("n1", 40, 30), rect("n2", 300, 30)], [edge("e1", "n1", "n2")]);
  const bottom = scene([rect("n1", 200, 40)]);

  it("is one diagram's copy, ids and all, when only one holds the selection", () => {
    const html = pageClipboardHtml([
      { scene: top, ids: ["n1", "n2"], dy: 0 },
      { scene: bottom, ids: [], dy: 400 },
    ])!;
    const copy = parseScene(html, parseHtml);
    expect(copy.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(copy.edges).toHaveLength(1);
  });

  it("mints one set of ids across diagrams and keeps each connector on its shapes", () => {
    const html = pageClipboardHtml([
      { scene: top, ids: ["n1", "n2"], dy: 0 },
      { scene: bottom, ids: ["n1"], dy: 400 },
    ])!;
    const copy = parseScene(html, parseHtml);
    const ids = copy.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
    expect(copy.edges).toHaveLength(1);
    const [link] = copy.edges;
    expect([link.from, link.to]).toEqual([ids[0], ids[1]]);
  });

  it("stacks each diagram's shapes by how far apart the bands are, and never across", () => {
    const html = pageClipboardHtml([
      { scene: top, ids: ["n1"], dy: 0 },
      { scene: bottom, ids: ["n1"], dy: 400 },
    ])!;
    const copy = parseScene(html, parseHtml);
    expect(copy.nodes.map((n) => [n.x, n.y])).toEqual([
      [40, 30],
      [200, 440],
    ]);
  });

  it("is nothing when nothing is selected", () => {
    expect(pageClipboardHtml([{ scene: top, ids: [], dy: 0 }])).toBeNull();
  });
});

describe("landFragment", () => {
  const target = scene([rect("n1", 40, 40)]);

  it("keeps the coordinates it was copied at, under ids the diagram does not have", () => {
    const { ops, ids } = landFragment(target, { nodes: [rect("n1", 200, 50)], edges: [] });
    const landed = applyOps(target, ops);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe("n1");
    const node = landed.nodes.find((n) => n.id === ids[0])!;
    expect([node.x, node.y]).toEqual([200, 50]);
  });

  it("moves by the offset, for a paste back over its originals", () => {
    const { ops, ids } = landFragment(target, { nodes: [rect("n1", 40, 40)], edges: [] }, { offset: 10 });
    const node = applyOps(target, ops).nodes.find((n) => n.id === ids[0])!;
    expect([node.x, node.y]).toEqual([50, 50]);
  });

  it("carries the connectors between what it lands", () => {
    const { ops, ids } = landFragment(target, {
      nodes: [rect("a", 0, 0), rect("b", 300, 0)],
      edges: [edge("x", "a", "b")],
    });
    const landed = applyOps(target, ops);
    const added = landed.edges.at(-1)!;
    expect([added.from, added.to]).toEqual(ids);
  });

  it("holds what fits the column inside it, and nothing above the top", () => {
    const { ops, ids } = landFragment(target, { nodes: [rect("a", 680, -30)], edges: [] });
    const landed = applyOps(target, ops);
    const node = landed.nodes.find((n) => n.id === ids[0])!;
    expect([node.x, node.y]).toEqual([620, 0]);
    expect(landed.wide).toBeUndefined();
  });

  it("makes the diagram wide for a fragment wider than the column", () => {
    const { ops } = landFragment(target, { nodes: [rect("a", 0, 0, 1000, 80)], edges: [] });
    const landed = applyOps(target, ops);
    expect(landed.wide).toBe(true);
    const node = landed.nodes.at(-1)!;
    expect(node.w).toBe(1000);
    expect(node.x).toBeGreaterThanOrEqual(-240);
    expect(node.x + node.w).toBeLessThanOrEqual(960);
  });

  it("scales a fragment wider than even the wide band down to fit it", () => {
    const { ops } = landFragment(target, { nodes: [rect("a", 0, 0, 1440, 900)], edges: [] });
    const landed = applyOps(target, ops);
    const node = landed.nodes.at(-1)!;
    expect(landed.wide).toBe(true);
    expect(Math.round(node.w)).toBe(WIDE_W);
    expect(node.x).toBe(-240);
  });

  it("pastes into an entered group in the group's own space", () => {
    const group = {
      ...rect("g", 100, 100, 300, 200),
      kind: "group",
      children: [rect("c", 10, 10)],
    } as unknown as SceneNode;
    const withGroup = scene([group]);
    const { ops } = landFragment(withGroup, { nodes: [rect("a", 150, 150)], edges: [] }, { parentId: "g" });
    const insert = ops.find((op) => op.type === "insert")!;
    expect(insert).toMatchObject({ parentId: "g" });
    const node = (insert as { nodes: SceneNode[] }).nodes[0];
    expect([node.x, node.y]).toEqual([50, 50]);
  });
});

describe("diagramFromClipboard", () => {
  it("makes a band whose shapes start at its margin, as tall as they need", () => {
    const html = '<nt-diagram h="0"><nt-rect id="n1" x="80" y="300" w="100" h="60"></nt-rect></nt-diagram>';
    const made = parseScene(diagramFromClipboard(html, parseHtml)!, parseHtml);
    expect(made.w).toBe(0);
    expect(made.nodes[0]).toMatchObject({ x: 80, y: 24 });
    expect(made.h).toBe(24 + 60 + 24);
  });

  it("is nothing for a clipboard with no shapes in it", () => {
    expect(diagramFromClipboard('<nt-diagram h="10"></nt-diagram>', parseHtml)).toBeNull();
  });
});
