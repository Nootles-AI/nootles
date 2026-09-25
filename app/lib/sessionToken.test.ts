import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REAUTH_GIVE_UP_AFTER,
  TOKEN_ASK_TIMEOUT_MS,
  patientToken,
  reauthDelay,
  reauthState,
  tokenDelay,
} from "./sessionToken";

describe("patientToken", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const signedIn = () => true;

  it("hands over a token on the first ask without waiting or saying so", async () => {
    const ask = vi.fn(async () => "t1");
    const onWait = vi.fn();
    await expect(patientToken(ask, { signedIn, onWait })).resolves.toBe("t1");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onWait).not.toHaveBeenCalled();
  });

  it("asks again after a throw and after an empty answer, and says it is waiting", async () => {
    const ask = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("t2");
    const onWait = vi.fn();
    const token = patientToken(ask, { signedIn, onWait, delay: () => 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(onWait.mock.calls).toEqual([[true]]);
    await vi.advanceTimersByTimeAsync(10);
    await expect(token).resolves.toBe("t2");
    expect(ask).toHaveBeenCalledTimes(3);
    expect(onWait.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps asking through an outage for as long as Clerk is signed in", async () => {
    let calls = 0;
    const ask = vi.fn(async () => (++calls === 20 ? "late" : null));
    const token = patientToken(ask, { signedIn });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(token).resolves.toBe("late");
  });

  it("settles on null once Clerk no longer has a session", async () => {
    let session = true;
    const ask = vi.fn(async () => null);
    const onWait = vi.fn();
    const token = patientToken(ask, { signedIn: () => session, onWait });
    await vi.advanceTimersByTimeAsync(tokenDelay(0));
    session = false;
    await vi.advanceTimersByTimeAsync(tokenDelay(1));
    await expect(token).resolves.toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(onWait.mock.calls).toEqual([[true], [false]]);
  });

  it("does not let one stalled ask hold up the next", async () => {
    const ask = vi
      .fn<() => Promise<string | null>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce("t3");
    const token = patientToken(ask, { signedIn });
    await vi.advanceTimersByTimeAsync(TOKEN_ASK_TIMEOUT_MS + tokenDelay(0));
    await expect(token).resolves.toBe("t3");
  });
});

describe("tokenDelay", () => {
  it("doubles from half a second and stops at thirty", () => {
    expect([0, 1, 2, 5, 6, 10].map(tokenDelay)).toEqual([500, 1000, 2000, 16_000, 30_000, 30_000]);
  });
});

describe("reauthDelay", () => {
  it("doubles from a second and stops at thirty", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reauthDelay)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ]);
  });
});

describe("reauthState", () => {
  const live = { isSignedIn: true, isLoading: false, isAuthenticated: true };
  const refused = { isSignedIn: true, isLoading: false, isAuthenticated: false };

  it("counts no tries while Convex holds the token, however often it was asked before", () => {
    expect(reauthState({ asked: 7, held: 3, ...live })).toEqual({
      held: 7,
      tries: 0,
      dropped: false,
      stuck: false,
    });
  });

  it("counts the asks since Convex last held a token", () => {
    expect(reauthState({ asked: 9, held: 7, ...refused })).toMatchObject({
      tries: 2,
      dropped: true,
      stuck: false,
    });
  });

  it("is stuck once enough asks have been refused", () => {
    const asked = 7 + REAUTH_GIVE_UP_AFTER;
    expect(reauthState({ asked, held: 7, ...refused }).stuck).toBe(true);
    expect(reauthState({ asked: asked - 1, held: 7, ...refused }).stuck).toBe(false);
  });

  it("is not a drop while Convex is still deciding, or once Clerk is signed out", () => {
    expect(reauthState({ asked: 1, held: 0, ...refused, isLoading: true }).dropped).toBe(false);
    expect(reauthState({ asked: 1, held: 0, ...refused, isSignedIn: false }).dropped).toBe(false);
    expect(reauthState({ asked: 1, held: 0, ...refused, isSignedIn: undefined }).dropped).toBe(
      false,
    );
  });
});
