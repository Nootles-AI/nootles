/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AI } from "../app/lib/ai/aiConfig";
import componentSchema from "../node_modules/@convex-dev/rate-limiter/src/component/schema";
import { api, components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import {
  admit,
  isRateRefusal,
  limitMode,
  limitName,
  REQUEST_LIMITS,
  type Bucket,
  type Scope,
} from "./requestLimits";
import schema from "./schema";

/**
 * The admission authority, which nothing calls yet. What is checked here is
 * therefore everything a later caller will be entitled to assume: that a
 * bucket cannot be overspent, that it belongs to whoever is asking and to
 * nobody they can name, that a refusal costs nothing, and that each of the
 * three deployment modes does exactly what its name says — including the one
 * that must never be able to break a request.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts",
);

const ME = { subject: "user_me" };
const YOU = { subject: "user_you" };
/** The same person, reached through an operator's read-only stand-in token. */
const STAND_IN = { subject: "user_me", act: "ops_session_1" };

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("rateLimiter", componentSchema, componentModules);
  return t;
}

/**
 * Tokens left in one bucket, as of the last time something wrote it.
 *
 * The component's own reader does not advance the value to now — a query that
 * read the clock would go stale without anything invalidating it — so this
 * answers "what was banked", not "what would be granted this instant". That is
 * what makes it exact, and why refill is asserted by asking for a token rather
 * than by reading one. A bucket never touched answers with its full capacity.
 */
async function left(
  t: TestConvex<typeof schema>,
  bucket: Bucket,
  scope: Scope = "user",
  key: string | undefined = ME.subject,
): Promise<number> {
  return await t.run(async (ctx) => {
    const state = await ctx.runQuery(components.rateLimiter.lib.getValue, {
      name: limitName(bucket, scope),
      key: scope === "user" ? key : undefined,
      config: REQUEST_LIMITS[bucket][scope],
    });
    return state.value;
  });
}

/** A bucket holds exactly `tokens`. Exact because the clock is stopped. */
function expectLeft(actual: number, tokens: number): void {
  expect(actual).toBe(tokens);
}

/** Spends `count` of someone's own bucket without going through the gate. */
async function spendUser(
  t: TestConvex<typeof schema>,
  bucket: Bucket,
  count: number,
  key = ME.subject,
): Promise<void> {
  const status = await t.run(async (ctx) =>
    ctx.runMutation(components.rateLimiter.lib.rateLimit, {
      name: limitName(bucket, "user"),
      key,
      count,
      config: REQUEST_LIMITS[bucket].user,
    }),
  );
  expect(status.ok).toBe(true);
}

/**
 * Empties a lane's fleet bucket.
 *
 * Sharding makes this less trivial than it sounds. A request reaches a shard
 * it picks at random, so a call that finds an empty pair says nothing about
 * the other eight — hence draining until a long run of calls is refused. And
 * a shard holding less than the amount being asked for cannot be emptied by
 * asking for that amount, so the passes ask for less each time, ending at one.
 * Nothing refills underneath it, because the clock is stopped.
 */
const SPENT_RUN = 60;

async function exhaustFleet(
  t: TestConvex<typeof schema>,
  bucket: Bucket,
): Promise<void> {
  const config = REQUEST_LIMITS[bucket].global;
  const shards = config.shards ?? 1;
  const perShard = Math.floor((config.capacity ?? config.rate) / shards);
  for (let count = perShard; ; count = Math.max(1, Math.floor(count / 4))) {
    let refusals = 0;
    for (let attempt = 0; attempt < 2000 && refusals < SPENT_RUN; attempt++) {
      const status = await t.run(async (ctx) =>
        ctx.runMutation(components.rateLimiter.lib.rateLimit, {
          name: limitName(bucket, "global"),
          count,
          config,
        }),
      );
      refusals = status.ok ? 0 : refusals + 1;
    }
    if (refusals < SPENT_RUN) {
      throw new Error(`the ${bucket} fleet bucket would not empty`);
    }
    if (count === 1) return;
  }
}

/** The gate, as a route would reach it. */
function consume(t: TestConvex<typeof schema>, bucket: Bucket) {
  return t.mutation(api.requestLimits.consume, { bucket });
}

/**
 * Every test runs on a stopped clock.
 *
 * Buckets refill continuously, and the fast lanes refill FAST — the ambient
 * completion fleet earns 500 tokens a second, which is more than a drain loop
 * can spend. Under a real clock "empty" is not a state a test can hold, and
 * every count becomes an approximation. Stopped, the arithmetic is exact and
 * time only moves when a test says so.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the policy", () => {
  test("every lane's ceiling clears the cadence its own debounce allows", () => {
    /**
     * The claim each of these numbers is chosen to make: a surface that cannot
     * fire faster than its debounce cannot empty a bucket that refills faster
     * than that. Read from the config rather than restated, so lowering a
     * debounce past its ceiling fails here instead of in production.
     */
    const perMs = (bucket: Bucket) => {
      const { rate, period } = REQUEST_LIMITS[bucket].user;
      return rate / period;
    };
    expect(perMs("ambientCompletion")).toBeGreaterThan(1 / AI.timing.ghostDebounceMs);
    expect(perMs("ambientTransform")).toBeGreaterThan(1 / AI.reformat.debounceMs);
    // Media search debounces 250ms and Places 300ms; the faster one bounds it.
    expect(perMs("externalLookup")).toBeGreaterThan(1 / 250);
  });

  test("one chat turn cannot block itself", () => {
    // Every provider generation is counted, and a turn runs a tool loop up to
    // `maxSteps` of them, so the burst has to hold a whole turn and then some.
    expect(REQUEST_LIMITS.agentGeneration.user.capacity).toBeGreaterThanOrEqual(
      AI.chat.maxSteps * 2,
    );
  });

  test("each fleet ceiling is a hundred callers' worth, and sharded", () => {
    for (const [name, policy] of Object.entries(REQUEST_LIMITS)) {
      expect(policy.global.rate, name).toBe(policy.user.rate * 100);
      expect(policy.global.capacity, name).toBe(
        (policy.user.capacity ?? policy.user.rate) * 100,
      );
      expect(policy.global.kind, name).toBe(policy.user.kind);
      // One row per lane would be the hottest document in the deployment.
      expect(policy.global.shards ?? 1, name).toBeGreaterThan(1);
      // One person is not a write hotspot, so their bucket is one row.
      expect("shards" in policy.user, name).toBe(false);
    }
  });
});

describe("whose bucket it is", () => {
  test("an unauthenticated caller is refused before any bucket is touched", async () => {
    const t = harness();
    await expect(consume(t, "agentGeneration")).rejects.toThrow("Not signed in");
    expectLeft(
      await left(t, "agentGeneration"),
      REQUEST_LIMITS.agentGeneration.user.capacity,
    );
  });

  test("an operator standing in cannot spend the account's budget", async () => {
    const t = harness();
    await expect(
      t.withIdentity(STAND_IN).mutation(api.requestLimits.consume, {
        bucket: "agentGeneration",
      }),
    ).rejects.toThrow("Read-only");
    expectLeft(
      await left(t, "agentGeneration"),
      REQUEST_LIMITS.agentGeneration.user.capacity,
    );
  });

  test("a caller cannot name the bucket they are spending", async () => {
    const t = harness();
    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        bucket: "agentGeneration",
        // @ts-expect-error — there is no key argument, and that is the point.
        key: YOU.subject,
      }),
    ).rejects.toThrow();
    expectLeft(
      await left(t, "agentGeneration", "user", YOU.subject),
      REQUEST_LIMITS.agentGeneration.user.capacity,
    );
  });

  test("one collaborator's exhausted bucket leaves the other's untouched", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const capacity = REQUEST_LIMITS.agentGeneration.user.capacity;
    await spendUser(t, "agentGeneration", capacity, ME.subject);

    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        bucket: "agentGeneration",
      }),
    ).rejects.toThrow();
    const theirs = await t
      .withIdentity(YOU)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" });
    expect(theirs.outcome).toBe("admitted");
    expectLeft(await left(t, "agentGeneration", "user", YOU.subject), capacity - 1);
  });
});

describe("admission", () => {
  test("admits to the brim, then refuses with a time to come back", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const { capacity, rate, period } = REQUEST_LIMITS.agentGeneration.user;
    await spendUser(t, "agentGeneration", capacity - 1);

    const last = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" });
    expect(last).toEqual({
      bucket: "agentGeneration",
      mode: "enforce",
      outcome: "admitted",
    });

    const refused = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isRateRefusal(refused)).toBe(true);
    if (!isRateRefusal(refused)) throw new Error("unreachable");
    expect(refused.data.bucket).toBe("agentGeneration");
    expect(refused.data.scope).toBe("user");
    // Exactly one token back, at this lane's own refill rate.
    expect(refused.data.retryAfterMs).toBe(Math.ceil(period / rate));
    expect(Number.isInteger(refused.data.retryAfterMs)).toBe(true);
  });

  test("concurrent calls cannot overspend one bucket", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await spendUser(
      t,
      "agentGeneration",
      REQUEST_LIMITS.agentGeneration.user.capacity - 1,
    );

    // One token, five askers. Whatever order the backend runs them in, four
    // have to lose: the read and the write are one transaction per request.
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        t.withIdentity(ME).mutation(api.requestLimits.consume, {
          bucket: "agentGeneration",
        }),
      ),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        expect(isRateRefusal(outcome.reason)).toBe(true);
      }
    }
    expectLeft(await left(t, "agentGeneration"), 0);
  });

  test("lanes are spent separately", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await spendUser(
      t,
      "agentGeneration",
      REQUEST_LIMITS.agentGeneration.user.capacity,
    );

    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        bucket: "agentGeneration",
      }),
    ).rejects.toThrow();
    const other = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "ambientCompletion" });
    expect(other.outcome).toBe("admitted");
  });

  test("a fleet refusal costs the caller nothing", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const capacity = REQUEST_LIMITS.agentGeneration.user.capacity;

    await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" });
    expectLeft(await left(t, "agentGeneration"), capacity - 1);

    await exhaustFleet(t, "agentGeneration");
    const refused = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isRateRefusal(refused)).toBe(true);
    if (!isRateRefusal(refused)) throw new Error("unreachable");
    expect(refused.data.scope).toBe("global");

    // The whole reason the two checks run in a subtransaction: the caller was
    // turned away by the fleet, so the caller's own bucket is where it was.
    expectLeft(await left(t, "agentGeneration"), capacity - 1);
  });
});

describe("deployment modes", () => {
  test("enforce throws, and the refusal survives as data", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await spendUser(
      t,
      "ambientTransform",
      REQUEST_LIMITS.ambientTransform.user.capacity,
    );
    const refused = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "ambientTransform" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isRateRefusal(refused)).toBe(true);
  });

  test("observe reports the refusal and admits anyway", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    const t = harness();
    await spendUser(
      t,
      "ambientTransform",
      REQUEST_LIMITS.ambientTransform.user.capacity,
    );
    const decision = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "ambientTransform" });
    expect(decision.outcome).toBe("refused");
    expect(decision.mode).toBe("observe");
    expect(decision.scope).toBe("user");
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  test("observe spends what enforce would, so what it measures is real", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    const t = harness();
    await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "ambientTransform" });
    expectLeft(
      await left(t, "ambientTransform"),
      REQUEST_LIMITS.ambientTransform.user.capacity - 1,
    );
  });

  test("off admits an empty bucket and spends nothing", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "off");
    const t = harness();
    const capacity = REQUEST_LIMITS.ambientTransform.user.capacity;

    for (let i = 0; i < 3; i++) {
      const decision = await t
        .withIdentity(ME)
        .mutation(api.requestLimits.consume, { bucket: "ambientTransform" });
      expect(decision).toEqual({
        bucket: "ambientTransform",
        mode: "off",
        outcome: "admitted",
      });
    }
    expectLeft(await left(t, "ambientTransform"), capacity);
  });

  test("turning enforcement off and back on keeps the buckets", async () => {
    const t = harness();
    await spendUser(
      t,
      "ambientTransform",
      REQUEST_LIMITS.ambientTransform.user.capacity,
    );

    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        bucket: "ambientTransform",
      }),
    ).rejects.toThrow();

    // The rollback: stop refusing without deleting state, then resume.
    vi.stubEnv("RATE_LIMIT_MODE", "off");
    expect(
      (
        await t.withIdentity(ME).mutation(api.requestLimits.consume, {
          bucket: "ambientTransform",
        })
      ).outcome,
    ).toBe("admitted");

    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        bucket: "ambientTransform",
      }),
    ).rejects.toThrow();
  });

  test("an unset or misspelled mode observes", () => {
    vi.stubEnv("RATE_LIMIT_MODE", undefined);
    expect(limitMode()).toBe("observe");
    vi.stubEnv("RATE_LIMIT_MODE", "");
    expect(limitMode()).toBe("observe");
    vi.stubEnv("RATE_LIMIT_MODE", "enfroce");
    expect(limitMode()).toBe("observe");
    vi.stubEnv("RATE_LIMIT_MODE", "  ENFORCE ");
    expect(limitMode()).toBe("enforce");
  });
});

describe("when the limiter itself is broken", () => {
  /** A context whose component calls fail, standing in for an outage. */
  const broken = (ctx: MutationCtx): MutationCtx => ({
    ...ctx,
    runMutation: () => Promise.reject(new Error("limiter unreachable")),
  });

  test("enforce fails closed, so nothing reaches the provider", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await t.withIdentity(ME).run(async (ctx) => {
      await expect(admit(broken(ctx), "agentGeneration")).rejects.toThrow(
        "limiter unreachable",
      );
    });
  });

  test("observe fails open, because it enforces nothing", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    const t = harness();
    await t.withIdentity(ME).run(async (ctx) => {
      const decision = await admit(broken(ctx), "agentGeneration");
      expect(decision).toEqual({
        bucket: "agentGeneration",
        mode: "observe",
        outcome: "unavailable",
      });
    });
  });

  test("off never asks the limiter at all", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "off");
    const t = harness();
    await t.withIdentity(ME).run(async (ctx) => {
      const decision = await admit(broken(ctx), "agentGeneration");
      expect(decision.outcome).toBe("admitted");
    });
  });

  test("a broken limiter still refuses a caller who is not signed in", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "off");
    const t = harness();
    await t.run(async (ctx) => {
      await expect(admit(broken(ctx), "agentGeneration")).rejects.toThrow(
        "Not signed in",
      );
    });
  });
});

/**
 * The same checks again, over the whole closed union rather than one
 * representative lane. Three of the five were otherwise never exercised, and
 * `uploadGrant` is the only fixed window — different arithmetic, different
 * retry shape, and the one a bulk album import will meet first.
 */
const BUCKETS = Object.keys(REQUEST_LIMITS) as Bucket[];

describe("every lane", () => {
  test("has a name of its own", () => {
    const names = BUCKETS.flatMap((b) => [
      limitName(b, "user"),
      limitName(b, "global"),
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  test.each(BUCKETS)("%s admits, empties, and then refuses", async (bucket) => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const { capacity, period } = REQUEST_LIMITS[bucket].user;

    const first = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket });
    expect(first.outcome).toBe("admitted");

    await spendUser(t, bucket, capacity - 1);
    const refused = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isRateRefusal(refused), bucket).toBe(true);
    if (!isRateRefusal(refused)) throw new Error("unreachable");
    expect(refused.data.bucket).toBe(bucket);
    expect(refused.data.scope).toBe("user");
    // Never longer than the window the capacity belongs to, and never zero —
    // a "come back immediately" would send a client straight into a retry loop.
    expect(refused.data.retryAfterMs).toBeGreaterThan(0);
    expect(refused.data.retryAfterMs).toBeLessThanOrEqual(period);
  });

  test.each(BUCKETS)("%s consults the fleet, and a fleet refusal is free", async (bucket) => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const { capacity } = REQUEST_LIMITS[bucket].user;
    await exhaustFleet(t, bucket);

    // A caller who has spent nothing: the only bucket that can refuse them is
    // the fleet's, which is how this proves the second check runs at all.
    const refused = await t
      .withIdentity(YOU)
      .mutation(api.requestLimits.consume, { bucket })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isRateRefusal(refused), bucket).toBe(true);
    if (!isRateRefusal(refused)) throw new Error("unreachable");
    expect(refused.data.scope).toBe("global");
    expectLeft(await left(t, bucket, "user", YOU.subject), capacity);
  });
});

describe("one budget, however many sessions", () => {
  /** Two tabs of one account: same Clerk subject, different session tokens. */
  const TAB_A = {
    subject: "user_two_tabs",
    issuer: "https://clerk.test",
    tokenIdentifier: "https://clerk.test|session_a",
  };
  const TAB_B = {
    subject: "user_two_tabs",
    issuer: "https://clerk.test",
    tokenIdentifier: "https://clerk.test|session_b",
  };

  test("the last token is spent once, whichever tab takes it", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const { capacity } = REQUEST_LIMITS.agentGeneration.user;
    await spendUser(t, "agentGeneration", capacity - 1, TAB_A.subject);

    const mine = await t
      .withIdentity(TAB_A)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" });
    expect(mine.outcome).toBe("admitted");

    // The other tab holds a different session token for the same person, and
    // the bucket is keyed on the person.
    await expect(
      t.withIdentity(TAB_B).mutation(api.requestLimits.consume, {
        bucket: "agentGeneration",
      }),
    ).rejects.toThrow();
  });
});

describe("the refusal is not mistaken for anything else", () => {
  test("only this module's refusal narrows", () => {
    expect(isRateRefusal(new ConvexError("Read-only: standing in"))).toBe(false);
    // What the component throws on its own, which this module never asks for.
    expect(
      isRateRefusal(new ConvexError({ kind: "RateLimited", name: "x", retryAfter: 1 })),
    ).toBe(false);
    expect(isRateRefusal(new Error("rate_limit"))).toBe(false);
    expect(isRateRefusal({ data: { code: "rate_limit" } })).toBe(false);
    expect(isRateRefusal(null)).toBe(false);
    expect(isRateRefusal(undefined)).toBe(false);
  });

  test("an unknown lane is refused by the validator, not by the policy", async () => {
    const t = harness();
    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        // @ts-expect-error — the union is closed, and that is the contract.
        bucket: "somethingElse",
      }),
    ).rejects.toThrow();
  });
});

describe("what a refusal is allowed to say", () => {
  test("the log line carries the lane, never the person", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = harness();
      await spendUser(
        t,
        "ambientTransform",
        REQUEST_LIMITS.ambientTransform.user.capacity,
      );
      await t
        .withIdentity(ME)
        .mutation(api.requestLimits.consume, { bucket: "ambientTransform" });

      const lines = warn.mock.calls.map((call) => call.join(" "));
      expect(lines.some((line) => line.includes("ambientTransform"))).toBe(true);
      // The whole point of watching a rate rather than a person.
      for (const line of lines) expect(line).not.toContain(ME.subject);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("as a Convex function's own gate", () => {
  test("a refusal takes the caller's writes down with it", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await spendUser(t, "uploadGrant", REQUEST_LIMITS.uploadGrant.user.capacity);

    // The shape `convex/uploads.ts` will take: work first, then the gate before
    // the thing that costs something. The gate throwing has to undo the work.
    await expect(
      t.withIdentity(ME).mutation(async (ctx) => {
        await ctx.db.insert("projects", {
          ownerId: ME.subject,
          title: "should not survive",
          createdAt: 1,
        });
        await admit(ctx, "uploadGrant");
        return null;
      }),
    ).rejects.toThrow();

    const rows = await t.run(async (ctx) => await ctx.db.query("projects").collect());
    expect(rows).toHaveLength(0);
  });

  test("an admission commits with the caller's writes", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const decision = await t.withIdentity(ME).mutation(async (ctx) => {
      await ctx.db.insert("projects", {
        ownerId: ME.subject,
        title: "kept",
        createdAt: 1,
      });
      return await admit(ctx, "uploadGrant");
    });
    expect(decision.outcome).toBe("admitted");
    const rows = await t.run(async (ctx) => await ctx.db.query("projects").collect());
    expect(rows).toHaveLength(1);
    expectLeft(
      await left(t, "uploadGrant"),
      REQUEST_LIMITS.uploadGrant.user.capacity - 1,
    );
  });

  test("a caller that fails AFTER admission is not charged", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await expect(
      t.withIdentity(ME).mutation(async (ctx) => {
        await admit(ctx, "uploadGrant");
        throw new Error("the work itself failed");
      }),
    ).rejects.toThrow("the work itself failed");
    // One transaction: the token was never really spent, because the request
    // it was spent for never happened.
    expectLeft(await left(t, "uploadGrant"), REQUEST_LIMITS.uploadGrant.user.capacity);
  });
});

describe("observe holds the same line", () => {
  test("a fleet refusal costs the caller nothing there either", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "observe");
    const t = harness();
    const { capacity } = REQUEST_LIMITS.ambientCompletion.user;
    await exhaustFleet(t, "ambientCompletion");

    const decision = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "ambientCompletion" });
    expect(decision.outcome).toBe("refused");
    expect(decision.scope).toBe("global");
    expectLeft(await left(t, "ambientCompletion"), capacity);
  });
});

/**
 * What a stopped clock is really for: moving it deliberately. A retry time is
 * a promise to a client, and these are the tests that the promise is kept.
 */
describe("coming back later", () => {
  test("a token bucket admits again exactly when it said it would", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await spendUser(
      t,
      "agentGeneration",
      REQUEST_LIMITS.agentGeneration.user.capacity,
    );

    const refused = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    if (!isRateRefusal(refused)) throw new Error("expected a refusal");
    const { retryAfterMs } = refused.data;

    // A millisecond early is still early — a client that rounds down loops.
    vi.advanceTimersByTime(retryAfterMs - 1);
    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        bucket: "agentGeneration",
      }),
    ).rejects.toThrow();

    vi.advanceTimersByTime(1);
    const admitted = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "agentGeneration" });
    expect(admitted.outcome).toBe("admitted");
  });

  test("a fixed window admits again at its next window", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await spendUser(t, "uploadGrant", REQUEST_LIMITS.uploadGrant.user.capacity);

    const refused = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "uploadGrant" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    if (!isRateRefusal(refused)) throw new Error("expected a refusal");
    // Never further off than one whole window, whenever this window began.
    expect(refused.data.retryAfterMs).toBeLessThanOrEqual(
      REQUEST_LIMITS.uploadGrant.user.period,
    );

    vi.advanceTimersByTime(refused.data.retryAfterMs);
    const admitted = await t
      .withIdentity(ME)
      .mutation(api.requestLimits.consume, { bucket: "uploadGrant" });
    expect(admitted.outcome).toBe("admitted");
  });

  test("waiting a week does not buy a bigger burst than the capacity", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    const { capacity } = REQUEST_LIMITS.agentGeneration.user;
    await spendUser(t, "agentGeneration", capacity);

    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);

    // The ceiling is the ceiling: capacity through, then refused, with no
    // credit accrued for the days nobody was asking. Asserted by asking rather
    // than by reading, because `left` reports the stored value and a week of
    // refill has not been written down yet.
    for (let i = 0; i < capacity; i++) {
      await t
        .withIdentity(ME)
        .mutation(api.requestLimits.consume, { bucket: "agentGeneration" });
    }
    await expect(
      t.withIdentity(ME).mutation(api.requestLimits.consume, {
        bucket: "agentGeneration",
      }),
    ).rejects.toThrow();
  });
});
