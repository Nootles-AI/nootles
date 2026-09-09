import { describe, expect, it } from "vitest";

import { isPinned, measureGroup, resolveLayout } from "./autoLayout";
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
