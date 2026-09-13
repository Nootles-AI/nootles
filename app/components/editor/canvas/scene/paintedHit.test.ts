import { describe, expect, it } from "vitest";
import { hitTest, hitTestAll, hitTestPath } from "./geometry";
import { visiblePaint } from "./paintedHit";
import { loadClipper } from "./boolean";
import type { GroupNode, SceneNode } from "./types";

const box = (id: string, style: Record<string, string> = { background: "red" }): SceneNode => ({
  kind: "rect", id, x: 0, y: 0, w: 100, h: 100, rot: 0, hidden: false, locked: false, label: "", attrs: {}, style,
});
const group = (children: SceneNode[], style: Record<string, string> = {}): GroupNode => ({ ...box("group", style), kind: "group", children });

describe("paint-aware selection", () => {
  it.each<Record<string, string>>([{}, { background: "transparent" }, { background: "#00000000" }, { background: "rgba(1, 2, 3, 0)" }, { border: "2px solid black" }])("clicks through an unpainted interior %o", (style) => {
    expect(hitTest([box("below"), box("above", style)], { x: 50, y: 50 })?.id).toBe("below");
  });
  it("selects the visible border, not the hollow interior", () => {
    const scene = [box("below"), box("above", { border: "2px solid black" })];
    expect(hitTest(scene, { x: 1, y: 50 })?.id).toBe("above");
    expect(hitTest(scene, { x: 50, y: 50 })?.id).toBe("below");
  });
  it("tests open paths against their curve instead of their rectangle", () => {
    const path: SceneNode = { ...box("path", { fill: "none", stroke: "black", "stroke-width": "2" }), kind: "path", d: "M0 0 C0 100 100 0 100 100" };
    expect(hitTest([box("below"), path], { x: 50, y: 10 })?.id).toBe("below");
    expect(hitTest([path], { x: 50, y: 50 })?.id).toBe("path");
  });
  it("respects multiple subpaths and fill rules", () => {
    const path: SceneNode = { ...box("path", { fill: "black", "fill-rule": "evenodd" }), kind: "path", d: "M0 0H100V100H0Z M25 25H75V75H25Z" };
    expect(hitTest([box("below"), path], { x: 50, y: 50 })?.id).toBe("below");
    expect(hitTest([path], { x: 10, y: 10 })?.id).toBe("path");
    expect(hitTest([{ ...path, style: { fill: "black" } }], { x: 50, y: 50 })?.id).toBe("path");
  });
  it("respects ellipse holes and sectors", () => {
    const ring: SceneNode = { ...box("ring"), kind: "ellipse", inner: 0.6 };
    expect(hitTest([box("below"), ring], { x: 50, y: 50 })?.id).toBe("below");
    expect(hitTest([ring], { x: 50, y: 5 })?.id).toBe("ring");
    expect(hitTest([{ ...ring, inner: 0, start: 0, sweep: 90 }], { x: 20, y: 20 })).toBeNull();
  });
  it("lets a click pass through the subtracted region of a boolean", async () => {
    await loadClipper();
    const cut: GroupNode = { ...group([box("outer"), { ...box("hole"), x: 25, y: 25, w: 50, h: 50 }], { background: "red" }), op: "subtract" };
    expect(hitTest([box("below"), cut], { x: 50, y: 50 })?.id).toBe("below");
    expect(hitTest([box("below"), cut], { x: 10, y: 10 })?.id).toBe("group");
  });
  it("respects rotated clipping ancestors and ignores hidden/locked branches", () => {
    const clipped = group([{ ...box("outside"), x: 120 }], { overflow: "hidden" });
    expect(hitTest([clipped], { x: 150, y: 50 })).toBeNull();
    expect(hitTest([{ ...clipped, style: {} }], { x: 150, y: 50 }, { deep: true })?.id).toBe("outside");
    expect(hitTest([{ ...clipped, style: {}, rot: 90 }], { x: 50, y: 150 }, { deep: true })?.id).toBe("outside");
    expect(hitTest([{ ...clipped, style: {}, locked: true }], { x: 150, y: 50 })).toBeNull();
  });
  it("returns every overlapping selectable layer in front-to-back order", () => {
    const scene = [box("back"), group([box("front")])];
    expect(hitTestAll(scene, { x: 50, y: 50 }).map((n) => n.id)).toEqual(["front", "group", "back"]);
    expect(hitTestPath(scene, { x: 50, y: 50 }).map((n) => n.id)).toEqual(["group", "front"]);
  });
  it("uses numeric CSS stacking order with source order as the tie breaker", () => {
    const scene = [box("high", { background: "red", "z-index": "2" }), box("last")];
    expect(hitTestAll(scene, { x: 50, y: 50 }).map((n) => n.id)).toEqual(["high", "last"]);
    expect(hitTest(scene, { x: 50, y: 50 })?.id).toBe("high");
  });
  it("retains object-box selection for text and images", () => {
    expect(hitTest([{ ...box("text", {}), kind: "text" }], { x: 50, y: 50 })?.id).toBe("text");
  });
  it("does not mistake three-channel rgb with blue zero for alpha zero", () => {
    expect(visiblePaint("rgb(255, 0, 0)")).toBe(true);
  });
});
