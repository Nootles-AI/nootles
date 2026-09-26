import { describe, expect, it } from "vitest";
import { ARRIVE_STAGGER_CAP, ARRIVE_STAGGER_MS, arrivalDelays } from "./presetArrival";

describe("arrivalDelays", () => {
  it("staggers the pieces in order", () => {
    expect(arrivalDelays(3)).toEqual([0, ARRIVE_STAGGER_MS, 2 * ARRIVE_STAGGER_MS]);
  });

  it("brings everything past the cap in with the last", () => {
    const delays = arrivalDelays(ARRIVE_STAGGER_CAP + 4);
    expect(delays.at(-1)).toBe(ARRIVE_STAGGER_CAP * ARRIVE_STAGGER_MS);
    expect(Math.max(...delays)).toBe(ARRIVE_STAGGER_CAP * ARRIVE_STAGGER_MS);
  });

  it("has nothing to stagger for nothing", () => {
    expect(arrivalDelays(0)).toEqual([]);
  });
});
