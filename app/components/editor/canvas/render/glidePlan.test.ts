import { describe, expect, it } from "vitest";
import { laidOutScene } from "../scene/autoLayout";
import type { GroupNode, Scene, SceneNode } from "../scene/types";
import {
  ARRIVE_SCALE,
  BURST_MS,
  GLIDE_CAP,
  diffGlide,
  displace,
  easingOf,
  edgesTouching,
  enterKeyframes,
  frameAt,
  glideKeyframes,
  isBurst,
  tooMany,
  turn,
} from "./glidePlan";

const base = { rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} };

const rect = (id: string, x: number, y: number, over: Partial<SceneNode> = {}): SceneNode =>
  ({ ...base, id, kind: "rect", x, y, w: 100, h: 60, ...over }) as SceneNode;

const group = (id: string, x: number, y: number, children: SceneNode[], over: Partial<GroupNode> = {}): GroupNode =>
  ({ ...base, id, kind: "group", x, y, w: 300, h: 200, children, ...over }) as GroupNode;

const scene = (nodes: SceneNode[]): Scene => ({ w: 0, h: 0, style: {}, nodes, edges: [], attrs: {} });

/** A translation string back to numbers. */
const shift = (value: unknown) => String(value).split(" ").map((part) => Number.parseFloat(part));

describe("diffGlide", () => {
  it("offsets a moved shape by where it was, less where it is", () => {
    const diff = diffGlide(scene([rect("a", 10, 20), rect("b", 0, 0)]), scene([rect("a", 40, 25), rect("b", 0, 0)]));
    expect([...diff.moved]).toEqual([["a", { dx: -30, dy: -5, dr: 0 }]]);
    expect(diff.entered).toEqual([]);
    expect(diff.exited).toEqual([]);
  });

  it("turns the short way round", () => {
    const diff = diffGlide(scene([rect("a", 0, 0, { rot: 350 })]), scene([rect("a", 0, 0, { rot: 20 })]));
    expect(diff.moved.get("a")?.dr).toBeCloseTo(-30);
    expect(turn(180)).toBe(180);
    expect(turn(-180)).toBe(180);
    expect(turn(-340)).toBeCloseTo(20);
  });

  it("never turns a flip: a mirror moves, it does not spin", () => {
    const tri = (rot: number) => rect("t", 0, 0, { kind: "polygon", sides: 3, rot } as Partial<SceneNode>);
    expect(diffGlide(scene([tri(0)]), scene([tri(180)])).moved.size).toBe(0);
    expect(diffGlide(scene([tri(20)]), scene([tri(160)])).moved.size).toBe(0);
    expect([...diffGlide(scene([rect("a", 0, 0, { rot: 30 })]), scene([rect("a", 40, 0, { rot: -30 })])).moved]).toEqual([
      ["a", { dx: -40, dy: 0, dr: 0 }],
    ]);
    const path = (rot: number, d: string) => rect("p", 0, 0, { kind: "path", d, rot } as Partial<SceneNode>);
    expect(diffGlide(scene([path(10, "M0 0L10 0")]), scene([path(70, "M10 0L0 0")])).moved.size).toBe(0);
    // A rectangle's half turn is a turn.
    expect(diffGlide(scene([rect("a", 0, 0, { rot: 20 })]), scene([rect("a", 0, 0, { rot: 160 })])).moved.get("a")?.dr).toBeCloseTo(-140);
  });

  it("compares a child in its own parent's space, and ignores a size change", () => {
    const prev = scene([group("g", 0, 0, [rect("a", 10, 10)])]);
    const next = scene([group("g", 50, 0, [rect("a", 10, 10, { w: 300 })])]);
    expect([...diffGlide(prev, next).moved]).toEqual([["g", { dx: -50, dy: 0, dr: 0 }]]);
  });

  it("leaves a regrouped shape alone: a new parent is a new space, not a move", () => {
    const prev = scene([rect("a", 10, 10), rect("b", 200, 10)]);
    const next = scene([group("g", 10, 10, [rect("a", 0, 0), rect("b", 190, 0)])]);
    const diff = diffGlide(prev, next);
    expect(diff.moved.size).toBe(0);
    // The group holds shapes that were already there, so it does not arrive.
    expect(diff.entered).toEqual([]);
    // Nor does ungrouping make anything leave.
    const back = diffGlide(next, prev);
    expect(back.exited).toEqual([]);
    expect(back.entered).toEqual([]);
  });

  it("brings in and takes away whole subtrees, outermost only", () => {
    const prev = scene([rect("a", 0, 0), group("g", 0, 0, [rect("c", 0, 0)])]);
    const next = scene([rect("a", 0, 0), group("h", 0, 0, [rect("d", 0, 0)])]);
    const diff = diffGlide(prev, next);
    expect(diff.entered).toEqual(["h"]);
    expect(diff.exited).toEqual(["g"]);
  });

  it("glides the siblings a layout moved when one of them goes", () => {
    const row = (children: SceneNode[]) =>
      scene([group("g", 0, 0, children, { style: { display: "flex", gap: "10px" } })]);
    const prev = laidOutScene(row([rect("a", 0, 0), rect("b", 0, 0), rect("c", 0, 0)]));
    const next = laidOutScene(row([rect("a", 0, 0), rect("c", 0, 0)]));
    const diff = diffGlide(prev, next);
    expect(diff.exited).toEqual(["b"]);
    expect(diff.moved.get("c")?.dx).toBeCloseTo(110);
    expect(diff.moved.has("a")).toBe(false);
  });
});

describe("the cap and the burst", () => {
  it("lets a change of up to the cap glide, and no more", () => {
    const many = (n: number, x: number) => scene(Array.from({ length: n }, (_, i) => rect(`n${i}`, x, i)));
    expect(tooMany(diffGlide(many(GLIDE_CAP, 0), many(GLIDE_CAP, 5)))).toBe(false);
    expect(tooMany(diffGlide(many(GLIDE_CAP + 1, 0), many(GLIDE_CAP + 1, 5)))).toBe(true);
  });

  it("calls commits closer than a repeat a burst", () => {
    expect(isBurst(1000, -Infinity)).toBe(false);
    expect(isBurst(1000 + BURST_MS - 1, 1000)).toBe(true);
    expect(isBurst(1000 + BURST_MS, 1000)).toBe(false);
  });
});

describe("glideKeyframes", () => {
  it("is a plain translation to nothing when nothing turns", () => {
    expect(glideKeyframes({ dx: -30, dy: 5, dr: 0 }, 400, 200)).toEqual([
      { translate: "-30px 5px" },
      { translate: "0px 0px" },
    ]);
  });

  it("keeps a turning shape pivoting about its own centre", () => {
    const x = 200;
    const y = 100;
    const frames = glideKeyframes({ dx: 10, dy: 0, dr: 90 }, x, y);
    const first = frames[0];
    const last = frames[frames.length - 1];
    expect(first.offset).toBe(0);
    expect(last.offset).toBe(1);
    expect(last.rotate).toBe("0deg");
    expect(shift(last.translate).map((n) => Math.abs(n) < 1e-9)).toEqual([true, true]);
    // At the start the element's origin, rotated by the extra turn about the
    // parent's, is put back where the old position had it: (x + dx, y + dy).
    const [tx, ty] = shift(first.translate);
    expect(first.rotate).toBe("90deg");
    const rotated = { x: -y, y: x };
    expect(tx + rotated.x).toBeCloseTo(x + 10);
    expect(ty + rotated.y).toBeCloseTo(y);
    expect(frames.length).toBeGreaterThan(2);
  });
});

describe("enterKeyframes", () => {
  it("fades alone under reduced motion", () => {
    expect(enterKeyframes(300, 100, true)).toEqual([{ offset: 0, opacity: 0 }]);
  });

  it("hands back the translation the scale takes from the node's own", () => {
    const [frame] = enterKeyframes(300, 100, false);
    expect(frame.scale).toBe(String(ARRIVE_SCALE));
    const [tx, ty] = shift(frame.translate);
    expect(tx).toBeCloseTo((1 - ARRIVE_SCALE) * 300);
    expect(ty).toBeCloseTo((1 - ARRIVE_SCALE) * 100);
  });
});

describe("displace and frameAt", () => {
  it("draws the scene part way back, sharing what did not move", () => {
    const still = rect("b", 0, 0);
    const now = scene([rect("a", 100, 0), still]);
    const mid = displace(now, new Map([["a", { dx: -100, dy: 0, dr: 0 }]]), 0.25);
    expect(mid.nodes[0].x).toBe(75);
    expect(mid.nodes[1]).toBe(still);
    expect(displace(now, new Map([["a", { dx: -100, dy: 0, dr: 0 }]]), 0)).toBe(now);
  });

  it("carries only the connectors with an end on or under a gliding shape", () => {
    const edge = (id: string, from: string, to: string) => ({ id, from, to, style: {}, label: "", attrs: {} });
    const now = {
      ...scene([group("g", 0, 0, [rect("a", 0, 0)]), rect("b", 200, 0), rect("c", 400, 0)]),
      edges: [edge("ab", "a", "b"), edge("bc", "b", "c")],
    } as Scene;
    expect([...edgesTouching(now, ["g"])]).toEqual(["ab"]);
    expect([...edgesTouching(now, ["c"])]).toEqual(["bc"]);
    expect(edgesTouching(now, ["gone"]).size).toBe(0);
  });

  it("frames one shape with its turn, several as their union", () => {
    const now = scene([rect("a", 0, 0, { rot: 30 }), rect("b", 200, 100)]);
    const one = frameAt(now, ["a"])!;
    expect([one.w, one.h, one.rot]).toEqual([100, 60, 30]);
    expect(one.x).toBeCloseTo(0);
    expect(one.y).toBeCloseTo(0);
    expect(frameAt(now, ["b", "a"])?.rot).toBe(0);
    expect(frameAt(now, ["gone"])).toBeNull();
  });
});

describe("easingOf", () => {
  it("reads a cubic-bezier and pins its ends", () => {
    const ease = easingOf("cubic-bezier(0.25, 1, 0.5, 1)");
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    // An ease-out is well past halfway at the half.
    expect(ease(0.5)).toBeGreaterThan(0.8);
    expect(easingOf("linear(0, 1)")(0.3)).toBeCloseTo(0.3);
  });
});
