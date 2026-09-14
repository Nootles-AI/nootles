/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import componentSchema from "../../node_modules/@convex-dev/rate-limiter/src/component/schema";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { MIN_REQUEST_GAP_MS, pacer } from "./pacing";
import { NotionError } from "./rest";

/**
 * The queue a Notion connection's requests share. What is checked is what an
 * import relies on: however many invocations talk to one connection, their
 * requests reach Notion a gap apart; connections do not wait on each other; a
 * request that finds its connection idle is not held back; and a 429 holds
 * back the whole connection for as long as Notion asked, not only the request
 * that heard it.
 *
 * The clock is stopped and moved by hand, so every time below is exact.
 */

const modules = import.meta.glob("../**/*.ts");
const componentModules = import.meta.glob(
  "../../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts",
);

const START = new Date("2026-09-14T12:00:00Z").getTime();
const GAP = MIN_REQUEST_GAP_MS;

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  t = convexTest(schema, modules);
  t.registerComponent("rateLimiter", componentSchema, componentModules);
});

afterEach(() => {
  vi.useRealTimers();
});

/** One invocation's pacer, as an action holds it: its own, over a shared queue. */
function invocation(ownerId: string) {
  const runMutation = ((reference: never, args: never) =>
    t.run((ctx) => ctx.runMutation(reference, args))) as ActionCtx["runMutation"];
  const runQuery = ((reference: never, args: never) =>
    t.run((ctx) => ctx.runQuery(reference, args))) as ActionCtx["runQuery"];
  return pacer({ runQuery, runMutation }, ownerId);
}

/** Moves the clock timer by timer until `work` settles. */
async function drain<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  while (!settled) await vi.advanceTimersToNextTimerAsync();
  return watched;
}

const now = () => Date.now() - START;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one connection", () => {
  test("invocations reach Notion a gap apart, however many there are", async () => {
    const reached: number[] = [];
    const request = async () => {
      reached.push(now());
    };
    await drain(
      Promise.all([
        invocation("user_a")(request),
        invocation("user_a")(request),
        invocation("user_a")(request),
        invocation("user_a")(request),
      ]),
    );
    expect(reached.sort((a, b) => a - b)).toEqual([0, GAP, 2 * GAP, 3 * GAP]);
  });

  test("one invocation's requests are spaced as they always were", async () => {
    const paced = invocation("user_a");
    const reached: number[] = [];
    await drain(
      (async () => {
        for (let i = 0; i < 3; i++) await paced(async () => reached.push(now()));
      })(),
    );
    expect(reached).toEqual([0, GAP, 2 * GAP]);
  });

  test("a request that finds the connection idle goes at once", async () => {
    const paced = invocation("user_a");
    const reached: number[] = [];
    await drain(paced(async () => reached.push(now())));
    await vi.advanceTimersByTimeAsync(5000);
    await drain(invocation("user_a")(async () => reached.push(now())));
    expect(reached).toEqual([0, 5000]);
  });
});

describe("connections", () => {
  test("do not wait on each other", async () => {
    const reached: Record<string, number> = {};
    await drain(
      Promise.all([
        invocation("user_a")(async () => (reached.a = now())),
        invocation("user_b")(async () => (reached.b = now())),
      ]),
    );
    expect(reached).toEqual({ a: 0, b: 0 });
  });
});

describe("when Notion says to wait", () => {
  test("a 429 holds the whole connection back for Retry-After, then the request is retried", async () => {
    const reached: [string, number][] = [];
    let refused = false;
    const refusedOnce = invocation("user_a")(async () => {
      reached.push(["refused", now()]);
      if (!refused) {
        refused = true;
        throw new NotionError(429, "rate limited", false, 2);
      }
    });
    // Another invocation on the same connection, arriving just after the refusal.
    const other = (async () => {
      await sleep(100);
      await invocation("user_a")(async () => {
        reached.push(["other", now()]);
      });
    })();
    await drain(Promise.all([refusedOnce, other]));

    const [first, retry] = reached.filter(([who]) => who === "refused").map(([, at]) => at);
    const [, otherAt] = reached.find(([who]) => who === "other")!;
    expect(first).toBe(0);
    // Nothing reaches Notion inside the two seconds it asked for.
    expect(reached.filter(([, at]) => at > 0 && at < 2000)).toEqual([]);
    expect(retry).toBeGreaterThanOrEqual(2000);
    expect(otherAt).toBeGreaterThanOrEqual(retry + GAP);
  });

  test("a second 429 for the same request travels up", async () => {
    let attempts = 0;
    const error = await drain(
      invocation("user_a")(async () => {
        attempts++;
        throw new NotionError(429, "rate limited", false, 1);
      }).catch((e: unknown) => e),
    );
    expect(error).toBeInstanceOf(NotionError);
    expect((error as NotionError).status).toBe(429);
    expect(attempts).toBe(2);
  });

  test("any other failure is neither retried nor a pause for the connection", async () => {
    let attempts = 0;
    const error = await drain(
      invocation("user_a")(async () => {
        attempts++;
        throw new NotionError(404, "not shared");
      }).catch((e: unknown) => e),
    );
    expect((error as NotionError).status).toBe(404);
    expect(attempts).toBe(1);

    const reached: number[] = [];
    await drain(invocation("user_a")(async () => reached.push(now())));
    expect(reached).toEqual([GAP]);
  });
});
