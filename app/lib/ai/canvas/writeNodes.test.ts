import { describe, expect, it } from "vitest";
import { fitOps } from "@/app/components/editor/canvas/scene/band";
import { applyOps, setAttrs } from "@/app/components/editor/canvas/scene/ops";
import { findNode } from "@/app/components/editor/canvas/scene/types";
import { isRefusal } from "./host";
import { f1, fragment, parse } from "./fixtures";
import { planWriteNodes, type WritePlan } from "./writeNodes";

/** Unwraps a plan, failing loudly (with the refusal text) if the planner
 *  refused — every "expect a real plan" test goes through this. */
function ok(result: ReturnType<typeof planWriteNodes>): WritePlan {
  if (isRefusal(result)) throw new Error(`unexpected refusal: ${result.refused}`);
  return result;
}

describe("planWriteNodes", () => {
  it("rewrites a box in place (W1)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-rect id="s2" x="320" y="40" w="200" h="56" style="background: #f2f2f0">Ship</nt-rect>',
        ),
      ),
    );
    expect(plan.ops).toEqual([{ type: "resize", frames: [{ id: "s2", x: 320, y: 40, w: 200, h: 56 }] }]);
    expect(plan.updated).toEqual(["s2"]);
    expect(findNode(plan.next, "s2")).toMatchObject({ x: 320, y: 40 });
  });

  it("an unchanged element is no change (W2)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-rect id="s1" x="40" y="40" w="200" h="56" style="background: var(--brand); border-radius: 10px">Order</nt-rect>',
        ),
      ),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.next).toBe(scene);
  });

  it("style is replaced whole, dropped declarations are removed (W3)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment('<nt-rect id="s1" x="40" y="40" w="200" h="56" style="border-radius: 10px">Order</nt-rect>'),
      ),
    );
    const s1 = findNode(plan.next, "s1")!;
    expect(s1.style).toEqual({ "border-radius": "10px" });
  });

  it("an id-less element is minted and appended (W4)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect x="40" y="120" w="200" h="56">Pack</nt-rect>')),
    );
    expect(plan.inserted).toHaveLength(1);
    const id = plan.inserted[0];
    expect(plan.minted[id]).toBe(id);
    expect(plan.ops).toEqual([
      { type: "insert", nodes: [expect.objectContaining({ id, label: "Pack" })], parentId: null, index: 4 },
    ]);
  });

  it("at.after places right behind the anchor (W5)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect x="40" y="120" w="200" h="56">Pack</nt-rect>'), {
        at: { after: "s1" },
      }),
    );
    const op = plan.ops[0];
    expect(op).toMatchObject({ type: "insert", parentId: null, index: 1 });
  });

  it("at.inside appends into the group (W6)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect w="100" h="40">C</nt-rect>'), {
        at: { inside: "g1" },
      }),
    );
    expect(plan.ops[0]).toMatchObject({ type: "insert", parentId: "g1", index: 2 });
  });

  it("a flex child compares w/h only (W7)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect id="c1" x="999" y="999" w="120" h="40"></nt-rect>')),
    );
    expect(plan.ops).toEqual([{ type: "resize", frames: [{ id: "c1", x: 0, y: 0, w: 120, h: 40 }] }]);
  });

  it("listed children move, unlisted children stay (W8)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-group id="g1" x="40" y="160" w="460" h="80" style="display: flex; gap: 16px; padding: 12px">' +
            '<nt-rect id="c2" w="100" h="40"></nt-rect><nt-rect w="100" h="40">C3</nt-rect></nt-group>',
        ),
      ),
    );
    const g1 = findNode(plan.next, "g1")!;
    expect(g1.kind).toBe("group");
    if (g1.kind !== "group") throw new Error("not a group");
    expect(g1.children.map((c) => c.id)).toEqual(["c1", "c2", plan.inserted[0]]);
  });

  it("a kept unknown id lets an edge name a new shape (W9)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-rect id="s9" x="0" y="0" w="10" h="10"></nt-rect><nt-edge id="e2" from="s9" to="s1"></nt-edge>',
        ),
      ),
    );
    expect(plan.inserted).toEqual(["s9"]);
    expect(plan.edgesAdded).toEqual(["e2"]);
    expect(plan.next.edges.some((e) => e.id === "e2" && e.from === "s9" && e.to === "s1")).toBe(true);
  });

  it("a second connector between a joined pair is refused (W10)", () => {
    const scene = f1();
    const result = planWriteNodes(scene, fragment('<nt-edge from="s1" to="s2"></nt-edge>'));
    expect(isRefusal(result)).toBe(true);
  });

  it("a kind change is refused (W11)", () => {
    const scene = f1();
    const result = planWriteNodes(
      scene,
      fragment('<nt-ellipse id="s1" x="40" y="40" w="200" h="56"></nt-ellipse>'),
    );
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.refused).toContain("rectangle");
  });

  it("removing a group removes its subtree (W12)", () => {
    const scene = f1();
    const plan = ok(planWriteNodes(scene, fragment(""), { removing: ["g1"] }));
    expect(findNode(plan.next, "g1")).toBeNull();
    expect(findNode(plan.next, "c1")).toBeNull();
    expect(findNode(plan.next, "c2")).toBeNull();
  });

  it("removing a shape drops its connectors and reports them (W13)", () => {
    const scene = f1();
    const plan = ok(planWriteNodes(scene, fragment(""), { removing: ["s1"] }));
    expect(plan.edgesRemoved).toEqual(["e1"]);
    expect(plan.next.edges).toEqual([]);
  });

  it("an unknown removing id is refused (W14)", () => {
    const scene = f1();
    const result = planWriteNodes(scene, fragment(""), { removing: ["zz"] });
    expect(isRefusal(result)).toBe(true);
  });

  it("a path is adopted before it is compared (W15)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-path id="p1" x="520" y="40" w="999" h="999" d="M 10 10 L 50 50" style="stroke: #2b2b28; fill: none"></nt-path>',
        ),
      ),
    );
    const p1 = findNode(plan.next, "p1")!;
    expect(p1).toMatchObject({ x: 530, y: 50, w: 40, h: 40 });
    if (p1.kind === "path") expect(p1.d).toBe("M 0 0 L 40 40");
  });

  it("a wrapping nt-diagram sets the height, widens and restyles the surface — never a width (W16)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-diagram w="1200" h="480" wide data-width="fixed" style="--brand: #0f766e">' +
            '<nt-rect id="s1" x="40" y="40" w="200" h="56" style="background: var(--brand); border-radius: 10px">Order</nt-rect>' +
            "</nt-diagram>",
        ),
      ),
    );
    expect(plan.next.w).toBe(0);
    expect(plan.next.h).toBe(480);
    expect(plan.next.wide).toBe(true);
    expect(plan.next.style["--brand"]).toBe("#0f766e");
    expect(plan.next.attrs).toEqual({});
    expect(plan.ops[0]).toEqual({
      type: "setDiagram",
      h: 480,
      wide: true,
      style: { "--brand": "#0f766e" },
    });
    // s1 itself is unchanged text-for-text, so it produces no update op.
    expect(plan.updated).toEqual([]);
  });

  it("an echo of the read form's root changes nothing — its w is the page's (W16)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-diagram id="b7" w="720" h="400" style="--brand: #6366f1">' +
            '<nt-rect id="s1" x="40" y="40" w="200" h="56" style="background: var(--brand); border-radius: 10px">Order</nt-rect>' +
            "</nt-diagram>",
        ),
      ),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.next).toBe(scene);
  });

  it("an h below the content is raised to hold it (W16)", () => {
    const plan = ok(
      planWriteNodes(
        f1(),
        fragment('<nt-diagram h="96"><nt-rect id="s1" x="40" y="40" w="200" h="56" style="background: var(--brand); border-radius: 10px">Order</nt-rect></nt-diagram>'),
      ),
    );
    // g1 ends at 240; the band adds 24 below it.
    expect(plan.next.h).toBe(264);
  });

  it("content written past the column is scaled into it, said, and reproduced by the ops", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect id="far" x="900" y="40" w="100" h="56"></nt-rect>')),
    );
    // 40…1000 is 960 across: scaled by 720/960 about its top-left, then
    // nudged left so its right edge meets the column's.
    expect(plan.notes).toContain("The diagram was scaled to 0.75× to fit its 720px width.");
    expect(findNode(plan.next, plan.inserted[0])).toMatchObject({ x: 645, y: 40, w: 75, h: 42 });
    expect(findNode(plan.next, "s1")).toMatchObject({ x: 0, y: 40, w: 150, h: 42 });
    expect(applyOps(scene, plan.ops)).toEqual(plan.next);
    expect(fitOps(plan.next)).toEqual([]);
  });

  it("content past the column lands as written in a wide diagram", () => {
    const scene = { ...f1(), wide: true as const };
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect id="far" x="900" y="40" w="60" h="56"></nt-rect>')),
    );
    expect(plan.notes).toEqual([]);
    expect(findNode(plan.next, plan.inserted[0])).toMatchObject({ x: 900, y: 40, w: 60, h: 56 });
    expect(plan.ops.map((op) => op.type)).toEqual(["insert"]);
  });

  it("stub attributes never reach the diagram (W17)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-diagram id="b7" at="b7" holds="7 shapes" text="…"><nt-rect w="10" h="10"></nt-rect></nt-diagram>',
        ),
      ),
    );
    expect(plan.next.attrs).toEqual({});
    expect(plan.inserted).toHaveLength(1);
  });

  it("an existing shape written inside a new group is reparented then framed (W19)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment(
          '<nt-group id="g2" x="0" y="0" w="300" h="100">' +
            '<nt-rect id="s1" x="0" y="0" w="200" h="56">Order</nt-rect></nt-group>',
        ),
      ),
    );
    const g2 = findNode(plan.next, "g2");
    expect(g2?.kind).toBe("group");
    const s1 = findNode(plan.next, "s1")!;
    expect(s1.x).toBe(0);
    expect(s1.y).toBe(0);
    if (g2?.kind === "group") expect(g2.children.map((c) => c.id)).toEqual(["s1"]);
  });

  it("data-icon changes compile to setAttrs (W22)", () => {
    const scene = applyOps(parse('<nt-diagram h="100"><nt-rect id="p1" w="10" h="10"></nt-rect></nt-diagram>'), [
      { type: "setAttrs", id: "p1", attrs: { "data-icon": "cat" } },
    ]);
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect id="p1" w="10" h="10" data-icon="dog"></nt-rect>')),
    );
    expect(plan.ops).toEqual([{ type: "setAttrs", id: "p1", attrs: { "data-icon": "dog" } }]);
  });

  it("refuses when a removing id is also written", () => {
    const scene = f1();
    const result = planWriteNodes(scene, fragment('<nt-rect id="s1" x="40" y="40" w="200" h="56"></nt-rect>'), {
      removing: ["s1"],
    });
    expect(isRefusal(result)).toBe(true);
  });

  it("applyOps(scene, plan.ops) deep-equals plan.next", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(scene, fragment('<nt-rect x="0" y="0" w="10" h="10"></nt-rect>'), {
        at: { after: "s1" },
      }),
    );
    expect(applyOps(scene, plan.ops)).toEqual(plan.next);
  });

  it("untouched subtrees keep identity (structural sharing)", () => {
    const scene = f1();
    const plan = ok(
      planWriteNodes(
        scene,
        fragment('<nt-rect id="s2" x="320" y="40" w="200" h="56" style="background: #f2f2f0">Ship</nt-rect>'),
      ),
    );
    const before = scene.nodes.find((n) => n.id === "g1");
    const after = plan.next.nodes.find((n) => n.id === "g1");
    expect(after).toBe(before);
  });

  it("ids are deterministic (same input twice gives the same minted ids)", () => {
    const scene = f1();
    const a = ok(planWriteNodes(scene, fragment('<nt-rect x="0" y="0" w="10" h="10"></nt-rect>')));
    const b = ok(planWriteNodes(scene, fragment('<nt-rect x="0" y="0" w="10" h="10"></nt-rect>')));
    expect(a.inserted).toEqual(b.inserted);
  });

  it("setAttrs merges, undefined removes, reserved names are dropped, no-op keeps identity", () => {
    const scene = parse('<nt-diagram w="10" h="10"><nt-rect id="s1" x="0" y="0" w="10" h="10" data-a="1" data-b="2"></nt-rect></nt-diagram>');
    const merged = setAttrs(scene, "s1", { "data-b": "3", "data-c": "4" });
    expect(findNode(merged, "s1")!.attrs).toEqual({ "data-a": "1", "data-b": "3", "data-c": "4" });
    const removed = setAttrs(merged, "s1", { "data-a": undefined });
    expect(findNode(removed, "s1")!.attrs).toEqual({ "data-b": "3", "data-c": "4" });
    const reserved = setAttrs(scene, "s1", { x: "999" });
    expect(reserved).toBe(scene);
    const noop = setAttrs(scene, "s1", { "data-a": "1" });
    expect(noop).toBe(scene);
  });
});
