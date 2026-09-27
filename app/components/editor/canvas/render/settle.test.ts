import { describe, expect, it } from "vitest";
import { settleEase } from "./settle";

describe("settleEase", () => {
  it("starts at rest and ends at rest", () => {
    expect(settleEase(0)).toBe(0);
    expect(settleEase(1)).toBe(1);
    expect(settleEase(-1)).toBe(0);
    expect(settleEase(2)).toBe(1);
  });

  it("rises the whole way, most of it early — an ease out", () => {
    let last = 0;
    for (let i = 1; i <= 20; i++) {
      const y = settleEase(i / 20);
      expect(y).toBeGreaterThanOrEqual(last);
      last = y;
    }
    expect(settleEase(0.5)).toBeGreaterThan(0.8);
  });

  it("is the curve CSS draws: y(u) where x(u) = t", () => {
    // u = 0.5 on cubic-bezier(0.25, 0, 0, 1): x = 0.21875, y = 0.5.
    expect(settleEase(0.21875)).toBeCloseTo(0.5, 6);
  });
});
