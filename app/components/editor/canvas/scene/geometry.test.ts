import { describe, expect, it } from "vitest";
import { nodeBounds, unrotateBound } from "./geometry";

describe("unrotateBound", () => {
  it("recovers a turned box from the bound it draws", () => {
    const box = { x: 240, y: 50, w: 120, h: 70, rot: 30 };
    const found = unrotateBound(nodeBounds(box), 120, 70, 30)!;
    for (const key of ["x", "y", "w", "h", "rot"] as const) {
      expect(found[key]).toBeCloseTo(box[key], 9);
    }
  });

  it("takes an unrotated bound as the box, whatever size was expected", () => {
    const bound = { x: 10, y: 20, w: 200, h: 70 };
    expect(unrotateBound(bound, 120, 70, 0)).toEqual({ ...bound, rot: 0 });
  });

  it("declines a turned bound that is not that box — a resize is under way", () => {
    const bound = nodeBounds({ x: 0, y: 0, w: 180, h: 70, rot: 30 });
    expect(unrotateBound(bound, 120, 70, 30)).toBeNull();
  });

  it("allows the sub-pixel slack of a measured element", () => {
    const bound = nodeBounds({ x: 0, y: 0, w: 120, h: 70, rot: 45 });
    expect(unrotateBound({ ...bound, w: bound.w + 1 }, 120, 70, 45)).not.toBeNull();
  });
});
