import { ConvexError } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { RateRefusal } from "@/convex/requestLimits";
import { refuseIfLimited } from "./requestLimitGate";

/**
 * The gate turns the admission mutation's decision into an HTTP answer. What is
 * checked here is that mapping and only that: the mutation's own behaviour — who
 * is refused, whether a bucket can be overspent — is the subject of
 * `convex/requestLimits.test.ts`. Here the mutation is a stand-in that returns
 * or throws whatever a given deployment mode would, so the three answers the
 * routes depend on — proceed, `429`, `503` — are each pinned exactly.
 */

/** A Convex client whose `consume` does whatever the test needs. */
function convexThat(consume: () => Promise<unknown>): ConvexHttpClient {
  return { mutation: vi.fn(consume) } as unknown as ConvexHttpClient;
}

/** The refusal `enforce` throws — a `ConvexError` carrying the typed data. */
function refusal(overrides: Partial<RateRefusal> = {}): ConvexError<RateRefusal> {
  return new ConvexError<RateRefusal>({
    code: "rate_limit",
    bucket: "agentGeneration",
    scope: "user",
    retryAfterMs: 1200,
    ...overrides,
  });
}

describe("proceeding", () => {
  test("an admitted request returns null", async () => {
    const convex = convexThat(async () => ({
      bucket: "agentGeneration",
      mode: "enforce",
      outcome: "admitted",
    }));
    expect(await refuseIfLimited(convex, "agentGeneration")).toBeNull();
  });

  test("observe admits even when it would have refused, so the route proceeds", async () => {
    // Under `observe` the mutation returns a refusal decision rather than
    // throwing; the gate must read that as "proceed" or nothing could be
    // measured in production before it bites.
    const convex = convexThat(async () => ({
      bucket: "agentGeneration",
      mode: "observe",
      outcome: "refused",
      scope: "user",
      retryAfterMs: 900,
    }));
    expect(await refuseIfLimited(convex, "agentGeneration")).toBeNull();
  });

  test("the bucket it consumes is the one it was asked for", async () => {
    const consume = vi.fn(async () => ({ outcome: "admitted" }));
    const convex = { mutation: consume } as unknown as ConvexHttpClient;
    await refuseIfLimited(convex, "uploadGrant");
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith(expect.anything(), { bucket: "uploadGrant" });
  });
});

describe("a rate refusal becomes 429", () => {
  test("status, body contract, and Retry-After together", async () => {
    const convex = convexThat(async () => {
      throw refusal({ retryAfterMs: 1200 });
    });
    const res = await refuseIfLimited(convex, "agentGeneration");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(res!.headers.get("content-type")).toContain("application/json");
    // Whole seconds, rounded up: 1200ms → 2s.
    expect(res!.headers.get("retry-after")).toBe("2");
    expect(await res!.json()).toEqual({
      code: "rate_limit",
      bucket: "agentGeneration",
      retryAfterMs: 1200,
    });
  });

  test("the body names the bucket that actually refused", async () => {
    const convex = convexThat(async () => {
      throw refusal({ bucket: "externalLookup", scope: "global" });
    });
    const res = await refuseIfLimited(convex, "externalLookup");
    expect((await res!.json()).bucket).toBe("externalLookup");
  });

  test("Retry-After is whole seconds, rounded up, never zero", async () => {
    const cases: Array<[number, string]> = [
      [1, "1"], // sub-second still waits a second; "0" would loop a client
      [999, "1"],
      [1000, "1"],
      [1001, "2"],
      [7500, "8"],
    ];
    for (const [retryAfterMs, expected] of cases) {
      const convex = convexThat(async () => {
        throw refusal({ retryAfterMs });
      });
      const res = await refuseIfLimited(convex, "agentGeneration");
      expect(res!.headers.get("retry-after"), `${retryAfterMs}ms`).toBe(expected);
    }
  });
});

describe("a broken limiter becomes 503, distinct from 429 and 402", () => {
  test("a non-refusal error is 503 with no Retry-After", async () => {
    const convex = convexThat(async () => {
      throw new Error("limiter unreachable");
    });
    const res = await refuseIfLimited(convex, "agentGeneration");
    expect(res!.status).toBe(503);
    expect(res!.headers.get("retry-after")).toBeNull();
    expect(await res!.json()).toEqual({ code: "limiter_unavailable" });
  });

  test("a ConvexError that is NOT a rate refusal is still 503, not 429", async () => {
    // `enforce` fails closed by re-throwing the limiter's own error, which may
    // itself be a ConvexError. Only a `rate_limit` payload is a rate wall.
    const convex = convexThat(async () => {
      throw new ConvexError({ code: "something_else" });
    });
    const res = await refuseIfLimited(convex, "agentGeneration");
    expect(res!.status).toBe(503);
  });

  test("the quota refusal shape is not mistaken for a rate wall", async () => {
    // Belt and braces: an entitlement `402` payload reaching this gate must not
    // be read as a rate limit. It cannot happen in the routes — the gates are
    // separate calls — but the mapping must not depend on that.
    const convex = convexThat(async () => {
      throw new ConvexError({ code: "quota", meter: "chats", limit: 10 });
    });
    const res = await refuseIfLimited(convex, "agentGeneration");
    expect(res!.status).toBe(503);
  });
});
