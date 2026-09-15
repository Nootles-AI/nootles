import { describe, expect, it } from "vitest";
import { absoluteRect } from "@/app/components/editor/canvas/scene/geometry";
import { laidOutScene } from "@/app/components/editor/canvas/scene/autoLayout";
import { findNode } from "@/app/components/editor/canvas/scene/types";
import { isRefusal } from "./host";
import { f1, f2, parse } from "./fixtures";
import { planVerb, type VerbPlan } from "./verbs";

function ok(result: ReturnType<typeof planVerb>): VerbPlan {
  if (isRefusal(result)) throw new Error(`unexpected refusal: ${result.refused}`);
  return result;
}

describe("planVerb", () => {
  it("set_text on a shape escapes markup by default (V1)", () => {
    const plan = ok(planVerb(f1(), { verb: "set_text", id: "s1", text: "A & B" }));
    expect(findNode(plan.next, "s1")!.label).toBe("A &amp; B");
  });

  it("set_text with markup keeps it canonical (V2)", () => {
    const plan = ok(planVerb(f1(), { verb: "set_text", id: "s1", text: "<b>Hi</b>", markup: true }));
    expect(findNode(plan.next, "s1")!.label).toBe("<b>Hi</b>");
  });

  it("set_text on a group is refused (V3)", () => {
    const result = planVerb(f1(), { verb: "set_text", id: "g1", text: "x" });
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.refused).toContain("holds no words");
  });

  it("set_text on an edge (V4)", () => {
    const plan = ok(planVerb(f1(), { verb: "set_text", id: "e1", text: "next" }));
    expect(plan.next.edges.find((e) => e.id === "e1")!.label).toBe("next");
  });

  it("rename clears with null (V5)", () => {
    const named = ok(planVerb(f1(), { verb: "rename", id: "s1", name: "Foo" })).next;
    const plan = planVerb(named, { verb: "rename", id: "s1", name: null });
    const cleared = ok(plan).next;
    expect(findNode(cleared, "s1")!.name).toBeUndefined();
  });

  it("duplicate lands one insert per copy (V6)", () => {
    const plan = ok(planVerb(f1(), { verb: "duplicate", ids: ["s1"] }));
    expect(plan.result.copies).toHaveLength(1);
    const id = (plan.result.copies as string[])[0];
    const copy = findNode(plan.next, id)!;
    expect(copy).toMatchObject({ x: 50, y: 50, w: 200, h: 56 });
    expect(plan.ops).toEqual([
      { type: "insert", nodes: [expect.objectContaining({ id })], parentId: null, index: 1 },
    ]);
  });

  it("duplicate on a flex child is placed by flow, not offset (V6b)", () => {
    const scene = f1();
    const plan = ok(planVerb(scene, { verb: "duplicate", ids: ["c1"] }));
    const id = (plan.result.copies as string[])[0];
    const laid = laidOutScene(plan.next);
    const c1After = absoluteRect(laid, "c1");
    const copyRect = absoluteRect(laid, id);
    // The copy is g1's next flex sibling — not 10px down-right of c1.
    expect(copyRect.y).toBe(c1After.y);
    expect(copyRect.x).not.toBe(c1After.x + 10);
  });

  it("move by delta (V7)", () => {
    const plan = ok(planVerb(f1(), { verb: "move", ids: ["s1", "s2"], dx: 40 }));
    expect(plan.ops).toEqual([{ type: "move", ids: ["s1", "s2"], dx: 40, dy: 0 }]);
  });

  it("move an auto-layout child is refused (V8)", () => {
    const result = planVerb(f1(), { verb: "move", ids: ["c1"], x: 0, y: 0 });
    expect(isRefusal(result)).toBe(true);
  });

  it("move an auto-layout child by delta is also refused (V8b)", () => {
    const result = planVerb(f1(), { verb: "move", ids: ["c1"], dx: 10, dy: 0 });
    expect(isRefusal(result)).toBe(true);
  });

  it("move to an absolute position compiles to a delta (V9)", () => {
    const plan = ok(planVerb(f1(), { verb: "move", ids: ["s1"], x: 100 }));
    expect(plan.ops).toEqual([{ type: "move", ids: ["s1"], dx: 60, dy: 0 }]);
  });

  it("move refuses delta and position together (V10)", () => {
    const result = planVerb(f1(), { verb: "move", ids: ["s1"], dx: 10, x: 5 });
    expect(isRefusal(result)).toBe(true);
  });

  it("delete drops a shape and a connector, reporting both (V11)", () => {
    const plan = ok(planVerb(f1(), { verb: "delete", ids: ["s1", "e1"] }));
    expect(plan.summary).toContain("1 shape");
    expect(plan.summary).toContain("1 connector");
    expect(findNode(plan.next, "s1")).toBeNull();
    expect(plan.next.edges).toEqual([]);
  });

  it("reorder to front (V12)", () => {
    const plan = ok(planVerb(f1(), { verb: "reorder", ids: ["s1"], to: "front" }));
    expect(plan.next.nodes.at(-1)!.id).toBe("s1");
  });

  it("reorder into a flex group is placed by flow, not rebased (V13)", () => {
    const plan = ok(planVerb(f1(), { verb: "reorder", ids: ["s1"], to: { parent: "g1", index: 0 } }));
    expect(plan.notes?.some((n) => n.includes("g1") && n.includes("flow"))).toBe(true);
    const g1 = findNode(plan.next, "g1");
    expect(g1?.kind).toBe("group");
    if (g1?.kind === "group") expect(g1.children[0].id).toBe("s1");
  });

  it("reorder into a plain group keeps screen position (V13b)", () => {
    const scene = parse(
      '<nt-diagram w="600" h="400"><nt-rect id="s1" x="40" y="40" w="200" h="56"></nt-rect>' +
        '<nt-group id="gp" x="300" y="200" w="200" h="100"><nt-rect id="k1" x="0" y="0" w="40" h="40"></nt-rect></nt-group></nt-diagram>',
    );
    const before = absoluteRect(laidOutScene(scene), "s1");
    const plan = ok(planVerb(scene, { verb: "reorder", ids: ["s1"], to: { parent: "gp", index: 0 } }));
    expect(plan.notes).toBeUndefined();
    const after = absoluteRect(laidOutScene(plan.next), "s1");
    expect(after).toEqual(before);
  });

  it("group absorbs a qualifying frame (V14a)", () => {
    const plan = ok(planVerb(f2(), { verb: "group", ids: ["frame1", "a1", "a2"], name: "Card" }));
    const groupId = plan.result.groupId as string;
    const group = findNode(plan.next, groupId)!;
    expect(group.style).toEqual({ background: "#f5f5f5" });
    expect(group).toMatchObject({ x: 0, y: 0, w: 300, h: 200 });
    expect(findNode(plan.next, "frame1")).toBeNull();
    expect(plan.notes?.[0]).toContain("frame1");
  });

  it("a labelled candidate is not absorbed (V14b)", () => {
    const scene = parse(
      '<nt-diagram w="300" h="200"><nt-rect id="frame1" x="0" y="0" w="300" h="200">Card</nt-rect>' +
        '<nt-rect id="a1" x="20" y="20" w="100" h="60">A</nt-rect><nt-rect id="a2" x="180" y="20" w="100" h="60">B</nt-rect></nt-diagram>',
    );
    const plan = ok(planVerb(scene, { verb: "group", ids: ["frame1", "a1", "a2"] }));
    expect(findNode(plan.next, "frame1")).not.toBeNull();
    expect(plan.notes).toBeUndefined();
  });

  it("a rotated candidate is not absorbed (V14c)", () => {
    const scene = parse(
      '<nt-diagram w="300" h="200"><nt-rect id="frame1" x="0" y="0" w="300" h="200" rot="15"></nt-rect>' +
        '<nt-rect id="a1" x="20" y="20" w="100" h="60">A</nt-rect><nt-rect id="a2" x="180" y="20" w="100" h="60">B</nt-rect></nt-diagram>',
    );
    const plan = ok(planVerb(scene, { verb: "group", ids: ["frame1", "a1", "a2"] }));
    expect(findNode(plan.next, "frame1")).not.toBeNull();
  });

  it("two qualifying candidates disqualify absorption (V14d)", () => {
    const scene = parse(
      '<nt-diagram w="300" h="200"><nt-rect id="frame1" x="0" y="0" w="300" h="200"></nt-rect>' +
        '<nt-rect id="frame2" x="0" y="0" w="300" h="200"></nt-rect>' +
        '<nt-rect id="a1" x="20" y="20" w="100" h="60">A</nt-rect><nt-rect id="a2" x="180" y="20" w="100" h="60">B</nt-rect></nt-diagram>',
    );
    const plan = ok(planVerb(scene, { verb: "group", ids: ["frame1", "frame2", "a1", "a2"] }));
    expect(findNode(plan.next, "frame1")).not.toBeNull();
    expect(findNode(plan.next, "frame2")).not.toBeNull();
  });

  it("group with a boolean op needs two shapes (V15)", () => {
    const result = planVerb(f1(), { verb: "group", ids: ["s1"], op: "subtract" });
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.refused).toContain("two shapes");
  });

  it("ungroup dissolves a group (V16)", () => {
    const plan = ok(planVerb(f1(), { verb: "ungroup", ids: ["g1"] }));
    expect(findNode(plan.next, "g1")).toBeNull();
    expect(findNode(plan.next, "c1")).not.toBeNull();
    expect(plan.notes?.[0]).toContain("origin");
  });

  it("duplicate matches ContextMenu: one insert per copy at index+1", () => {
    const plan = ok(planVerb(f1(), { verb: "duplicate", ids: ["s1", "s2"] }));
    expect(plan.ops).toHaveLength(2);
    for (const op of plan.ops) expect(op.type).toBe("insert");
  });

  it("an unknown id is refused", () => {
    const result = planVerb(f1(), { verb: "rename", id: "zz", name: "x" });
    expect(isRefusal(result)).toBe(true);
  });
});
