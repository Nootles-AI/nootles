import { describe, expect, it } from "vitest";

import { isPinned, layoutGaps, measureGroup, resolveLayout } from "./autoLayout";
import type { GroupNode, SceneNode } from "./types";

const rect = (id: string, x: number, y: number, w: number, h: number, style: Record<string, string> = {}): SceneNode => ({
  kind: "rect",
  id,
  x,
  y,
  w,
  h,
  rot: 0,
  style,
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
});

describe("native flex agreement", () => {
  const base: GroupNode = { ...rect("row", 0, 0, 250, 200), kind: "group", style: { display: "flex", gap: "10px 20px", "align-content": "flex-start" },
    children: [rect("a", 0, 0, 100, 30), rect("b", 0, 0, 100, 40), rect("c", 0, 0, 100, 50)] };
  it("honours independent gaps and longhand precedence", () => {
    expect(layoutGaps({ gap: "10px 20px", "row-gap": "5px" })).toEqual({ row: 5, column: 20 });
    expect(resolveLayout(base).get("b")?.x).toBe(120);
  });
  it("wraps complete lines with the cross-axis gap", () => {
    const layout = resolveLayout({ ...base, style: { ...base.style, "flex-wrap": "wrap" } });
    expect(layout.get("a")).toEqual({ x: 0, y: 0, w: 100, h: 30 });
    expect(layout.get("b")).toEqual({ x: 120, y: 0, w: 100, h: 40 });
    expect(layout.get("c")).toEqual({ x: 0, y: 50, w: 100, h: 50 });
  });
  it("places reverse flow from the far edge, without reversing source order", () => {
    const layout = resolveLayout({ ...base, style: { ...base.style, "flex-direction": "row-reverse" } });
    expect(layout.get("a")?.x).toBe(150);
    expect(layout.get("b")?.x).toBe(30);
    expect(layout.get("c")?.x).toBe(-90);
  });
  it("wraps columns and reverse cross-axis lines", () => {
    const layout = resolveLayout({ ...base, h: 80, style: { ...base.style, "flex-direction": "column", "flex-wrap": "wrap-reverse" } });
    expect(layout.get("a")).toEqual({ x: 150, y: 0, w: 100, h: 30 });
    expect(layout.get("b")).toEqual({ x: 150, y: 40, w: 100, h: 40 });
    expect(layout.get("c")).toEqual({ x: 30, y: 0, w: 100, h: 50 });
  });
  it("does not allocate flow slots to display:none or absolutely positioned children", () => {
    const layout = resolveLayout({ ...base, children: [base.children[0], { ...base.children[1], style: { display: "none" } }, { ...base.children[2], x: 7, y: 8, style: { position: "absolute" } }] });
    expect(layout.has("b")).toBe(false);
    expect(layout.get("c")).toEqual({ x: 7, y: 8, w: 100, h: 50 });
  });
});

describe("a pinned child of an auto-layout group", () => {
  const row: GroupNode = {
    kind: "group",
    id: "g",
    x: 0,
    y: 0,
    w: 300,
    h: 100,
    rot: 0,
    style: { display: "flex", gap: "10px", padding: "5px" },
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
    children: [rect("a", 0, 0, 40, 20), rect("pin", 200, 60, 30, 30, { position: "absolute" }), rect("b", 0, 0, 40, 20)],
  };

  it("keeps its own place and takes no room in the flow", () => {
    expect(isPinned(row.children[1])).toBe(true);
    const rects = resolveLayout(row);
    expect(rects.get("a")).toEqual({ x: 5, y: 5, w: 40, h: 20 });
    expect(rects.get("b")).toEqual({ x: 55, y: 5, w: 40, h: 20 });
    expect(rects.get("pin")).toEqual({ x: 200, y: 60, w: 30, h: 30 });
    expect(measureGroup(row)).toEqual({ w: 100, h: 30 });
  });
});
