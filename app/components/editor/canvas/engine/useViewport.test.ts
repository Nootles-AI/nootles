import { describe, expect, it } from "vitest";
import { absorb } from "./useViewport";

describe("absorb", () => {
  it("takes every push while the content is larger than the container", () => {
    expect(absorb(-300, 2000, 800, 40)).toBe(40);
    expect(absorb(-300, 2000, 800, -40)).toBe(-40);
  });

  it("slides content that fits up to the edge, and no further", () => {
    // 400 wide in an 800 container, sitting at 200: room for 200 either way.
    expect(absorb(200, 400, 800, 50)).toBe(50);
    expect(absorb(200, 400, 800, 250)).toBe(200);
    expect(absorb(200, 400, 800, -250)).toBe(-200);
    expect(absorb(0, 400, 800, 10)).toBe(0);
    expect(absorb(400, 400, 800, -10)).toBe(0);
  });

  it("lets content past an edge come back in, never further out", () => {
    expect(absorb(-50, 400, 800, -30)).toBe(-30);
    // Back in and on across to the far edge, which is 450 away.
    expect(absorb(-50, 400, 800, -500)).toBe(-450);
    expect(absorb(-50, 400, 800, 30)).toBe(0);
  });

  it("answers nothing to no push", () => {
    expect(absorb(200, 400, 800, 0)).toBe(0);
  });
});
