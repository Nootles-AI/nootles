import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { confirmEmail, RETRY_DELAYS_MS } from "./confirmEmail";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const unanswered = () => Promise.reject(new Error("unanswered"));

describe("confirmEmail", () => {
  test("an answer, even of no address, is taken at once", async () => {
    for (const email of ["nia@acme.com", null]) {
      const ask = vi.fn(async () => email);
      await expect(confirmEmail(ask, new AbortController().signal)).resolves.toEqual({
        email,
        answered: true,
      });
      expect(ask).toHaveBeenCalledOnce();
    }
  });

  test("no answer is asked again after each delay, then settles as unanswered", async () => {
    const ask = vi.fn(unanswered);
    const result = confirmEmail(ask, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
    expect(ask).toHaveBeenCalledTimes(3);
    await expect(result).resolves.toEqual({ email: null, answered: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  test("a retry that is answered ends it", async () => {
    const answers = [unanswered, async () => "nia@acme.com"];
    const flaky = vi.fn(() => answers.shift()!());
    const result = confirmEmail(flaky, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await expect(result).resolves.toEqual({ email: "nia@acme.com", answered: true });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  test("stops, and answers nothing, once whoever asked has moved on", async () => {
    const ask = vi.fn(unanswered);
    const controller = new AbortController();
    const result = confirmEmail(ask, controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ask).toHaveBeenCalledOnce();

    const late = new AbortController();
    const answered = confirmEmail(async () => {
      late.abort();
      return "nia@acme.com";
    }, late.signal);
    await expect(answered).resolves.toBeUndefined();
  });
});
