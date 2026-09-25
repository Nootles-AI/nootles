import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patientToken, reauthDelay } from "./sessionToken";

describe("patientToken", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands over a token on the first ask without waiting", async () => {
    const ask = vi.fn(async () => "t1");
    await expect(patientToken(ask)).resolves.toBe("t1");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks again after a throw and after an empty answer", async () => {
    const ask = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("t2");
    const token = patientToken(ask, [10, 20]);
    await vi.advanceTimersByTimeAsync(10);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    await expect(token).resolves.toBe("t2");
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("settles on null once every delay has passed", async () => {
    const ask = vi.fn(async () => {
      throw new Error("network");
    });
    const token = patientToken(ask, [10, 20]);
    await vi.advanceTimersByTimeAsync(30);
    await expect(token).resolves.toBeNull();
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("fits every retry inside Convex's ten-second refresh leeway", async () => {
    const ask = vi.fn(async () => null);
    const token = patientToken(ask);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(token).resolves.toBeNull();
  });
});

describe("reauthDelay", () => {
  it("doubles from a second and stops at thirty", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reauthDelay)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ]);
  });
});
