import { describe, expect, it } from "vitest";
import { presetStep } from "./presetWalk";

describe("presetStep", () => {
  it("walks right through the options, then off the bar", () => {
    expect(presetStep("ArrowRight", 0, 6)).toEqual({ focus: 1 });
    expect(presetStep("ArrowRight", 4, 6)).toEqual({ focus: 5 });
    expect(presetStep("ArrowRight", 5, 6)).toEqual({ leave: 1 });
  });

  it("walks left back to the first, then back to the plate", () => {
    expect(presetStep("ArrowLeft", 3, 6)).toEqual({ focus: 2 });
    expect(presetStep("ArrowLeft", 0, 6)).toEqual({ leave: -1 });
  });

  it("enters on the first option when none holds focus", () => {
    expect(presetStep("ArrowRight", -1, 6)).toEqual({ focus: 0 });
  });

  it("goes round on the vertical arrows", () => {
    expect(presetStep("ArrowDown", 5, 6)).toEqual({ focus: 0 });
    expect(presetStep("ArrowUp", 0, 6)).toEqual({ focus: 5 });
  });

  it("jumps to the ends, and leaves every other key alone", () => {
    expect(presetStep("Home", 3, 6)).toEqual({ focus: 0 });
    expect(presetStep("End", 1, 6)).toEqual({ focus: 5 });
    expect(presetStep("Enter", 1, 6)).toBeNull();
    expect(presetStep("Tab", 1, 6)).toBeNull();
  });
});
