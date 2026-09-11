import { HOUR, MINUTE, RateLimiter, type RateLimitConfig } from "@convex-dev/rate-limiter";
import { ConvexError, v, type Infer } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireOwner } from "./auth";

/**
 * How FAST an account may spend — the one place that answers it.
 *
 * The sibling of `entitlements.ts`, and deliberately not the same question.
 * Entitlements answer whether an account may use a feature at all: a permanent
 * allowance, spent once, answered with `402` and an upgrade path. This answers
 * whether a caller who is entitled is asking too quickly, which is temporary,
 * answered with `429` and a time to come back. A paid account has no allowance
 * left to count and still has a ceiling here, because a runaway client spends
 * a provider key just as fast on a subscription as on a free trial.
 *
 * Two buckets are consulted for every request and both must admit it:
 *
 *   - the caller's own, keyed by their Clerk subject, so one user's burst is
 *     shared across their tabs, devices, sessions and every server instance;
 *   - the fleet's, one shared value per lane, so many individually reasonable
 *     users cannot between them exhaust one provider key.
 *
 * NOTHING CALLS THIS YET. It is the authority alone — the dependency, the
 * component storage, the auth boundary and the transaction semantics — landed
 * before any route or client depends on it, so each of those can be read on
 * its own. The routes arrive in later commits; see
 * `docs/per-user-rate-limiting-plan.md`.
 */

export const bucketValidator = v.union(
  v.literal("ambientCompletion"),
  v.literal("ambientTransform"),
  v.literal("agentGeneration"),
  v.literal("externalLookup"),
  v.literal("uploadGrant"),
);

/**
 * The closed set of lanes. A caller names one of these and nothing else — not
 * a limit, not a key, not a count — so the policy is entirely this module's.
 */
export type Bucket = Infer<typeof bucketValidator>;

/** Which of the two buckets answered no. */
export type Scope = "user" | "global";

type Policy = { user: RateLimitConfig; global: RateLimitConfig };

/**
 * The fleet ceiling, as a multiple of one caller's.
 *
 * A round number rather than a measured one, and honestly so: the number that
 * belongs here is a provider quota divided by a cost budget, and neither is
 * knowable from source. Read it as "a hundred users all at their own ceiling
 * at once" — far above a hundred users working normally, and still a bound.
 * Deployment gate B replaces it with real account quotas.
 */
const FLEET = 100;

/**
 * The fleet buckets are split across this many rows.
 *
 * One row per lane would be the hottest document in the system: every
 * admitted request writes it, and Convex would serialize the whole fleet's AI
 * traffic behind that one write. Sharded, a request touches one shard of two
 * it picks between, which costs a little accuracy at the edge — an unlucky
 * shard can refuse while the fleet has room — and buys the throughput to have
 * a fleet ceiling at all. Per-user buckets are unsharded: one person is not a
 * write hotspot.
 */
const FLEET_SHARDS = 10;

/**
 * One lane's pair. Generic in the caller's config so the table below keeps the
 * numbers it was written with — every bucket states its own capacity, and a
 * reader of `REQUEST_LIMITS` gets them rather than `number | undefined`.
 */
function policy<C extends RateLimitConfig>(
  user: C,
): { user: C; global: RateLimitConfig } {
  const scaled = {
    rate: user.rate * FLEET,
    capacity: (user.capacity ?? user.rate) * FLEET,
    shards: FLEET_SHARDS,
  };
  return { user, global: { ...user, ...scaled } };
}

/**
 * What each lane costs and how fast it may be spent.
 *
 * These are SAFETY ceilings, not product limits: every one is set above the
 * fastest a working client can legitimately ask, so that normal use never
 * reaches them and a loop is stopped anyway. Where a surface debounces, that
 * debounce is the derivation — a lane that cannot fire faster than every
 * 350 ms cannot exhaust a bucket that refills faster than that, which is a
 * property provable from the code rather than a hope about traffic.
 *
 * What is NOT derived from evidence yet: real per-user request rates and
 * provider quotas, which need production observation (deployment gate A).
 * Nothing here is enforced until then.
 *
 * A lane's fleet bucket bounds that LANE, not one vendor's key: `agentGeneration`
 * reaches the chat model and the diagram model, and `ambientTransform` reaches
 * the same diagram model again. Per-key ceilings need the vendor known at
 * admission, and the vendor is chosen at the wire in `app/lib/ai/providers.ts` —
 * so that arrives with the routes, not here.
 */
export const REQUEST_LIMITS = {
  /**
   * Inline suggestions. `AI.timing.ghostDebounceMs` is 350 ms, so one editor
   * cannot exceed ~2.9/s; 5/s leaves the room a second surface and clock
   * jitter need. Capacity is twenty seconds of uninterrupted typing at that
   * cadence — a burst nobody types through, and a loop's whole first breath.
   */
  ambientCompletion: policy({
    kind: "token bucket",
    rate: 300,
    period: MINUTE,
    capacity: 60,
  }),
  /**
   * Reformat, categorize, feedback completion. `AI.reformat.debounceMs` is
   * 900 ms — ~1.1/s at the very most, and the other two fire far more rarely.
   */
  ambientTransform: policy({
    kind: "token bucket",
    rate: 120,
    period: MINUTE,
    capacity: 30,
  }),
  /**
   * Chat, diagram, album indexing. Counted per PROVIDER generation rather than
   * per turn, because every generation spends the key — and one chat turn runs
   * a tool loop up to `AI.chat.maxSteps` (24) generations long. Capacity is
   * four such turns, so the longest valid turn cannot block itself, and its
   * continuations cannot either.
   */
  agentGeneration: policy({
    kind: "token bucket",
    rate: 480,
    period: HOUR,
    capacity: 96,
  }),
  /**
   * Chargeable Places modes and media search. Both are typeahead behind a
   * 250-300 ms debounce and a client-side answer cache, so ~4/s is the fastest
   * a person searching can ask; 5/s clears it.
   */
  externalLookup: policy({
    kind: "token bucket",
    rate: 300,
    period: MINUTE,
    capacity: 60,
  }),
  /**
   * Signed upload URLs. A fixed window rather than a token bucket because this
   * is a discrete act with no cadence to smooth: an album import mints one
   * grant per file (two for a video) three lanes wide, and either the import
   * fits in the window or it does not. Sized so a several-hundred-item import
   * finishes inside one hour while a loop is still bounded.
   */
  uploadGrant: policy({
    kind: "fixed window",
    rate: 1000,
    period: HOUR,
    // The component would default this to `rate`; said out loud so every lane
    // in this table answers the same questions.
    capacity: 1000,
  }),
} satisfies Record<Bucket, Policy>;

/**
 * The component's key for one bucket. The shape is part of the operating
 * contract: an incident that needs a bucket reset names it by this.
 */
export function limitName(bucket: Bucket, scope: Scope): string {
  return `${bucket}:${scope}`;
}

const limiter = new RateLimiter(components.rateLimiter);

/**
 * Whether the policy is applied, watched, or ignored.
 *
 * `observe` is the shape of the rollout: it consumes exactly as `enforce`
 * would and logs what it would have stopped, while admitting everything —
 * which is the only way to learn what these numbers do to real traffic
 * without a guess deciding it. `off` is the rollback, and it deletes nothing:
 * the buckets keep their state, so turning enforcement back on does not hand
 * everyone a fresh allowance.
 */
export type LimitMode = "off" | "observe" | "enforce";

/**
 * The deployment's setting, read per call so an operator's change takes effect
 * without a deploy. An unset or misspelled value observes: refusing to start
 * is worse than not enforcing, and enforcing on a typo is worse than both.
 */
export function limitMode(): LimitMode {
  const raw = process.env.RATE_LIMIT_MODE?.trim().toLowerCase();
  if (raw === "off" || raw === "observe" || raw === "enforce") return raw;
  if (raw) {
    console.warn(
      `requestLimits: RATE_LIMIT_MODE is "${raw}", not off|observe|enforce — observing`,
    );
  }
  return "observe";
}

/** The refusal, shaped so a route can answer 429 without reading the message. */
export type RateRefusal = {
  code: "rate_limit";
  bucket: Bucket;
  scope: Scope;
  retryAfterMs: number;
};

/**
 * `ConvexError` for the same reason `entitlements.ts` uses one: a production
 * deployment redacts a plain `Error`, and "come back in two seconds" has to
 * survive the trip to be worth sending.
 */
function refusal(
  bucket: Bucket,
  scope: Scope,
  retryAfter: number,
): ConvexError<RateRefusal> {
  // Whole milliseconds: the component answers in fractions, and every consumer
  // of this rounds up to a whole second anyway.
  const retryAfterMs = Math.ceil(retryAfter);
  return new ConvexError({ code: "rate_limit", bucket, scope, retryAfterMs });
}

/** True when `e` is this module's refusal — the caller's narrowing hook. */
export function isRateRefusal(e: unknown): e is ConvexError<RateRefusal> {
  return (
    e instanceof ConvexError &&
    typeof e.data === "object" &&
    e.data !== null &&
    (e.data as { code?: unknown }).code === "rate_limit"
  );
}

/**
 * One unit off both buckets, or nothing off either.
 *
 * Separate from `admit` so that "nothing off either" is true by construction
 * rather than by care: this runs as a subtransaction, so the throw below
 * unwinds the user bucket's consumption along with it. Were both checks
 * written inline, a request the fleet turned away would still have cost the
 * caller a token — charging someone for a refusal, and doing it in the one
 * mode where nothing is even being enforced.
 *
 * The key is derived HERE, from the session, inside the transaction that
 * spends it. There is no argument for it and no way to pass one: the whole
 * point of a per-user limit is that the user cannot choose whose it is.
 *
 * Internal, and not the entry point: this refuses whatever the deployment mode
 * says, because deciding what a refusal MEANS is `admit`'s job.
 */
export const debit = internalMutation({
  args: { bucket: bucketValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const limits = REQUEST_LIMITS[args.bucket];

    const mine = await limiter.limit(ctx, limitName(args.bucket, "user"), {
      key: owner,
      config: limits.user,
    });
    if (!mine.ok) throw refusal(args.bucket, "user", mine.retryAfter);

    const fleet = await limiter.limit(ctx, limitName(args.bucket, "global"), {
      config: limits.global,
    });
    if (!fleet.ok) throw refusal(args.bucket, "global", fleet.retryAfter);

    return null;
  },
});

const admissionValidator = v.object({
  bucket: bucketValidator,
  mode: v.union(v.literal("off"), v.literal("observe"), v.literal("enforce")),
  outcome: v.union(
    v.literal("admitted"),
    v.literal("refused"),
    v.literal("unavailable"),
  ),
  scope: v.optional(v.union(v.literal("user"), v.literal("global"))),
  retryAfterMs: v.optional(v.number()),
});

/**
 * What the authority decided. Only `observe` ever returns a decision other
 * than `admitted`: under `enforce` a refusal is a throw, because the caller's
 * next line is the one that spends money.
 */
export type Admission = Infer<typeof admissionValidator>;

/**
 * The gate. Call it immediately before the work that costs something.
 *
 * Signed-in only, in every mode — `off` turns off rate limiting, not
 * authentication — and never for an operator standing in: `requireOwner`
 * refuses a stand-in token, so an impersonated session cannot spend the
 * account's budget or reach a provider on their behalf.
 *
 * A limiter that is broken rather than refusing fails CLOSED under `enforce`:
 * the error propagates, the caller's transaction rolls back, and the route
 * answers 503 rather than making an unbounded provider call. Under `observe`
 * it fails open, which is the same promise from the other side — a mode that
 * enforces nothing must not be able to break a request either.
 */
export async function admit(ctx: MutationCtx, bucket: Bucket): Promise<Admission> {
  const mode = limitMode();
  await requireOwner(ctx);
  if (mode === "off") return { bucket, mode, outcome: "admitted" };

  try {
    await ctx.runMutation(internal.requestLimits.debit, { bucket });
    return { bucket, mode, outcome: "admitted" };
  } catch (error) {
    if (isRateRefusal(error)) {
      const { scope, retryAfterMs } = error.data;
      // The only line either mode logs, and the one gate A counts. No subject
      // and no request content: what is being watched is a rate, not a person.
      console.warn(
        `requestLimits: ${mode === "enforce" ? "refused" : "would refuse"} ` +
          `${bucket} on the ${scope} bucket; retry after ${retryAfterMs}ms`,
      );
      if (mode === "enforce") throw error;
      return { bucket, mode, outcome: "refused", scope, retryAfterMs };
    }
    if (mode === "enforce") throw error;
    console.warn(`requestLimits: ${bucket} could not be checked: ${String(error)}`);
    return { bucket, mode, outcome: "unavailable" };
  }
}

/**
 * The same gate, for callers outside Convex.
 *
 * The Next routes hold a Clerk session rather than a Convex context, so they
 * reach the authority through this. Convex functions that spend something
 * themselves call `admit` directly at their own boundary instead — one policy,
 * consulted from both sides, rather than a check a direct Convex call could
 * step around.
 */
export const consume = mutation({
  args: { bucket: bucketValidator },
  returns: admissionValidator,
  handler: async (ctx, args): Promise<Admission> => await admit(ctx, args.bucket),
});
