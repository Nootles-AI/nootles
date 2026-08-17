import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { Scene, SceneNode } from "../scene/types";
import { byOrder, keyBetween, keyForIndex } from "./order";
import {
  applySceneDiff,
  canvasMapName,
  materializeCanvas,
  populateCanvas,
} from "./ymap";

/**
 * The properties multiplayer stands on: the round trip is exact, the diff is
 * minimal, double-populate is commutative, and two divergent replicas
 * converge to one scene with both people's work in it.
 */

const rect = (id: string, x: number, over: Partial<SceneNode> = {}): SceneNode =>
  ({
    id,
    kind: "rect",
    x,
    y: 10,
    w: 100,
    h: 60,
    rot: 0,
    style: { background: "#eee" },
    label: `L${id}`,
    locked: false,
    hidden: false,
    attrs: {},
    ...over,
  }) as SceneNode;

const scene = (nodes: SceneNode[], edges: Scene["edges"] = []): Scene => ({
  w: 960,
  h: 540,
  style: {},
  nodes,
  edges,
  attrs: {},
});

function fresh(from: Scene): { doc: Y.Doc; root: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const root = doc.getMap(canvasMapName("b1"));
  doc.transact(() => populateCanvas(root, from));
  return { doc, root };
}

function connect(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe("order keys", () => {
  test("keyForIndex is strictly increasing", () => {
    let prev = "";
    for (let i = 0; i < 200; i++) {
      const key = keyForIndex(i);
      expect(key > prev).toBe(true);
      prev = key;
    }
  });

  test("keyBetween lands strictly between", () => {
    let keys = ["1", "z"];
    for (let i = 0; i < 200; i++) {
      const at = i % (keys.length - 1);
      const mid = keyBetween(keys[at], keys[at + 1]);
      expect(mid > keys[at] && mid < keys[at + 1]).toBe(true);
      keys.splice(at + 1, 0, mid);
      keys = [...keys].sort();
    }
  });

  test("byOrder ties break on id", () => {
    const list = [
      { order: "5", id: "b" },
      { order: "5", id: "a" },
    ].sort(byOrder);
    expect(list.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("round trip", () => {
  test("populate → materialize preserves the scene", () => {
    const source = scene(
      [
        rect("n1", 0),
        {
          ...rect("g1", 200),
          kind: "group",
          children: [rect("n2", 10), rect("n3", 120, { name: "Named" })],
        } as SceneNode,
        { ...rect("p1", 400), kind: "path", d: "M0 0L10 10Z" } as SceneNode,
      ],
      [
        {
          id: "e1",
          from: "n1",
          to: "p1",
          label: "flows",
          style: { stroke: "#111" },
          attrs: {},
        },
      ],
    );
    const { root } = fresh(source);
    expect(materializeCanvas(root)).toEqual(source);
  });

  test("dangling edges are hidden, and return when the shape does", () => {
    const source = scene(
      [rect("n1", 0), rect("n2", 200)],
      [{ id: "e1", from: "n1", to: "n2", label: "", style: {}, attrs: {} }],
    );
    const { doc, root } = fresh(source);
    doc.transact(() => applySceneDiff(root, source, scene([rect("n1", 0)])));
    expect(materializeCanvas(root).edges).toEqual([]);
    // The shape comes back (as concurrency can bring it) — so does the edge.
    doc.transact(() =>
      applySceneDiff(
        root,
        scene([rect("n1", 0)]),
        scene(
          [rect("n1", 0), rect("n2", 200)],
          [{ id: "e1", from: "n1", to: "n2", label: "", style: {}, attrs: {} }],
        ),
      ),
    );
    expect(materializeCanvas(root).edges).toHaveLength(1);
  });
});

describe("diff granularity", () => {
  test("a recolor rewrites neither frame nor order", () => {
    const base = scene([rect("n1", 0), rect("n2", 200)]);
    const { doc, root } = fresh(base);
    const shapes = root.get("shapes") as Y.Map<unknown>;
    const entry = shapes.get("n2") as Y.Map<unknown>;
    const frameBefore = entry.get("frame");
    const orderBefore = (entry.get("parent") as { order: string }).order;

    const recolored = scene([
      rect("n1", 0),
      rect("n2", 200, { style: { background: "#f00" } }),
    ]);
    doc.transact(() => applySceneDiff(root, base, recolored));

    expect(entry.get("frame")).toBe(frameBefore); // untouched, not rewritten
    expect((entry.get("parent") as { order: string }).order).toBe(orderBefore);
    expect((entry.get("style") as Record<string, string>).background).toBe("#f00");
  });

  test("a reorder rewrites only the moved shape's key", () => {
    const base = scene([rect("a", 0), rect("b", 100), rect("c", 200)]);
    const { doc, root } = fresh(base);
    const shapes = root.get("shapes") as Y.Map<unknown>;
    const keyOf = (id: string) =>
      ((shapes.get(id) as Y.Map<unknown>).get("parent") as { order: string })
        .order;
    const before = { a: keyOf("a"), b: keyOf("b"), c: keyOf("c") };

    // c moves to the back: [c, a, b]
    doc.transact(() =>
      applySceneDiff(root, base, scene([rect("c", 200), rect("a", 0), rect("b", 100)])),
    );
    expect(keyOf("a")).toBe(before.a);
    expect(keyOf("b")).toBe(before.b);
    expect(keyOf("c")).not.toBe(before.c);
    expect(materializeCanvas(root).nodes.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });
});

describe("convergence", () => {
  test("move vs recolor of the same shape both survive", () => {
    const base = scene([rect("n1", 0), rect("n2", 200)]);
    const a = fresh(base);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const rootB = b.getMap(canvasMapName("b1"));

    // A moves n1; B recolors n1 and adds n3 — concurrently.
    a.doc.transact(() =>
      applySceneDiff(a.root, base, scene([rect("n1", 50), rect("n2", 200)])),
    );
    b.transact(() =>
      applySceneDiff(
        rootB,
        base,
        scene([
          rect("n1", 0, { style: { background: "#0f0" } }),
          rect("n2", 200),
          rect("n3", 400),
        ]),
      ),
    );
    connect(a.doc, b);

    const sceneA = materializeCanvas(a.root);
    const sceneB = materializeCanvas(rootB);
    expect(sceneA).toEqual(sceneB);
    const n1 = sceneA.nodes.find((n) => n.id === "n1")!;
    expect(n1.x).toBe(50); // A's move
    expect(n1.style.background).toBe("#0f0"); // B's recolor
    expect(sceneA.nodes.some((n) => n.id === "n3")).toBe(true); // B's insert
  });

  test("a flush never deletes a concurrent insert it has not seen", () => {
    // The bug the first E2E caught: A moves a shape while B inserts one.
    // A's flush diffs against what A KNEW — B's insert is not "missing".
    const base = scene([rect("n1", 0)]);
    const a = fresh(base);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const rootB = b.getMap(canvasMapName("b1"));

    b.transact(() =>
      applySceneDiff(rootB, base, scene([rect("n1", 0), rect("n9", 300)])),
    );
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b)); // B's insert arrives...
    a.doc.transact(() =>
      // ...but A's store had not adopted it when A's move flushed.
      applySceneDiff(a.root, base, scene([rect("n1", 77)])),
    );
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));

    const sceneA = materializeCanvas(a.root);
    expect(sceneA).toEqual(materializeCanvas(rootB));
    expect(sceneA.nodes.some((n) => n.id === "n9")).toBe(true);
    expect(sceneA.nodes.find((n) => n.id === "n1")!.x).toBe(77);
  });

  test("a flush never writes stale values over a concurrent field edit", () => {
    const base = scene([rect("n1", 0), rect("n2", 200)]);
    const a = fresh(base);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const rootB = b.getMap(canvasMapName("b1"));

    // B recolors n2; the recolor reaches A's maps but not yet A's store.
    b.transact(() =>
      applySceneDiff(rootB, base, scene([rect("n1", 0), rect("n2", 200, { style: { background: "#00f" } })])),
    );
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b));
    // A moves n1, flushing a scene that still holds n2's OLD color.
    a.doc.transact(() =>
      applySceneDiff(a.root, base, scene([rect("n1", 42), rect("n2", 200)])),
    );
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));

    const sceneA = materializeCanvas(a.root);
    expect(sceneA.nodes.find((n) => n.id === "n2")!.style.background).toBe("#00f");
    expect(sceneA.nodes.find((n) => n.id === "n1")!.x).toBe(42);
  });

  test("double-populate from two clients converges byte-identically", () => {
    const source = scene([rect("n1", 0), rect("n2", 200)]);
    const a = fresh(source);
    const b = fresh(source);
    connect(a.doc, b.doc);
    expect(materializeCanvas(a.root)).toEqual(materializeCanvas(b.doc.getMap(canvasMapName("b1"))));
    expect(materializeCanvas(a.root)).toEqual(source);
  });

  test("concurrent reparent cycles hoist deterministically on both sides", () => {
    const g = (id: string, children: SceneNode[]): SceneNode =>
      ({ ...rect(id, 0), kind: "group", children }) as SceneNode;
    const base = scene([g("g1", [rect("n1", 0)]), g("g2", [rect("n2", 0)])]);
    const a = fresh(base);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc));
    const rootB = b.getMap(canvasMapName("b1"));

    // A puts g1 inside g2; B puts g2 inside g1 — a cycle once merged.
    a.doc.transact(() =>
      applySceneDiff(a.root, base, scene([g("g2", [rect("n2", 0), g("g1", [rect("n1", 0)])])])),
    );
    b.transact(() =>
      applySceneDiff(rootB, base, scene([g("g1", [rect("n1", 0), g("g2", [rect("n2", 0)])])])),
    );
    connect(a.doc, b);

    const sceneA = materializeCanvas(a.root);
    const sceneB = materializeCanvas(rootB);
    expect(sceneA).toEqual(sceneB);
    // Nothing vanished: all four shapes render somewhere.
    const ids: string[] = [];
    const collect = (nodes: readonly SceneNode[]) =>
      nodes.forEach((n) => {
        ids.push(n.id);
        if ("children" in n) collect((n as { children: SceneNode[] }).children);
      });
    collect(sceneA.nodes);
    expect(ids.sort()).toEqual(["g1", "g2", "n1", "n2"]);
  });
});
