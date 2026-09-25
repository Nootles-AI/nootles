import { describe, expect, it } from "vitest";
import { AI } from "./aiConfig";
import { DEFAULT_REACH, clampReach, suggestionLimits } from "./reach";

describe("suggestionLimits", () => {
  it("is the measured Complete at one end and Create at the other", () => {
    expect(suggestionLimits(0)).toEqual({ ...AI.reach.complete, allowBlocks: false });
    expect(suggestionLimits(1)).toEqual({ ...AI.reach.create, allowBlocks: true, minGrounding: 0 });
  });

  it("never grounds a completion that may hold a block", () => {
    for (let i = 0; i <= 100; i++) {
      const limits = suggestionLimits(i / 100);
      expect(limits.allowBlocks && limits.minGrounding > 0).toBe(false);
    }
  });

  it("lets the middle propose blocks, ungated, with a shorter leash than Create", () => {
    const middle = suggestionLimits(DEFAULT_REACH);
    expect(middle.allowBlocks).toBe(true);
    expect(middle.minGrounding).toBe(0);
    expect(middle.maxChars).toBeLessThan(AI.reach.create.maxChars);
    expect(middle.debounceMs).toBeGreaterThan(AI.reach.create.debounceMs);
  });

  it("clamps what it is handed", () => {
    expect(clampReach(-1)).toBe(0);
    expect(clampReach(2)).toBe(1);
    expect(clampReach(Number.NaN)).toBe(DEFAULT_REACH);
  });
});
