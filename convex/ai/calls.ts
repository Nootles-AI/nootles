import { mutation } from "../_generated/server";
import { ConvexError, v } from "convex/values";
import { holdsSeat, requireOwner } from "../auth";
import { containerFor, spendGuestDay } from "../entitlements";
import { utcDay } from "../plans";
import { addPeriodSpend } from "../teamBilling";
import { ledgerSecret, verifyCall } from "./callSignature";

/**
 * The LLM ledger: one row per model request, written fire-and-forget by the
 * API routes after each stream ends. Public rather than internal because the
 * routes act *as the user* through a session-token ConvexHttpClient, which
 * cannot reach internal functions. ownerId is derived server-side, and so is
 * the workspace a row is charged to, so a client can only file rows against
 * containers it spends in.
 *
 * The cost is the route's word, and a route is not the only thing that can
 * call this — so a row counts toward a bill or a cap only when the Next
 * server signed it (`callSignature.ts`). Anything else is kept, since a row
 * that never lands is a cost nobody sees, but kept unsigned.
 */

/** Far past any one real call; a row claiming more is not one. */
const MAX_CALL_USD = 100;
const MAX_TOKENS = 100_000_000;
const MAX_MODEL_CHARS = 200;

/**
 * How far a signature's time may sit from ours. Behind covers a route slow to
 * get its row out; ahead, a clock running fast. Outside it, a signature is
 * old or not ours.
 */
const SIGNED_BEHIND_MS = 10 * 60_000;
const SIGNED_AHEAD_MS = 60_000;

const inRange = (n: number | undefined, max: number) =>
  n === undefined || (Number.isFinite(n) && n >= 0 && n <= max);

export const record = mutation({
  args: {
    feature: v.union(
      v.literal("fim"),
      v.literal("reformat"),
      v.literal("diagram"),
      v.literal("chat"),
      v.literal("categorize"),
      v.literal("feedback"),
      v.literal("album"),
      v.literal("context"),
    ),
    model: v.string(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    latencyMs: v.number(),
    ttfbMs: v.optional(v.number()),
    status: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("aborted"),
      v.literal("timeout"),
    ),
    errorCode: v.optional(v.string()),
    costUsd: v.optional(v.number()),
    /**
     * The project the call was made in, as the request named it. Only ever
     * used to find the paying workspace, through the caller's own role — so it
     * is a string, and a bad one records the row against the caller rather
     * than losing it.
     */
    projectId: v.optional(v.string()),
    /** When the route signed the row, and the signature — both, or neither. */
    signedAt: v.optional(v.number()),
    signature: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, signedAt, signature, ...call }) => {
    const ownerId = await requireOwner(ctx);
    const tokens = [
      call.promptTokens,
      call.completionTokens,
      call.cacheReadTokens,
      call.cacheWriteTokens,
    ];
    if (
      !tokens.every((n) => inRange(n, MAX_TOKENS)) ||
      !inRange(call.costUsd, MAX_CALL_USD) ||
      !inRange(call.latencyMs, Number.MAX_SAFE_INTEGER) ||
      !inRange(call.ttfbMs, Number.MAX_SAFE_INTEGER) ||
      call.model.length > MAX_MODEL_CHARS
    ) {
      throw new ConvexError("That isn’t a model call anything could have made.");
    }

    const now = Date.now();
    const secret = ledgerSecret(process.env.AI_LEDGER_SECRET);
    let signed = false;
    if (secret && signature !== undefined && signedAt !== undefined) {
      const fresh = signedAt >= now - SIGNED_BEHIND_MS && signedAt <= now + SIGNED_AHEAD_MS;
      const valid =
        fresh &&
        (await verifyCall(secret, { ownerId, projectId, ...call, signedAt }, signature));
      // A signature that does not hold is somebody's attempt at one, and a
      // row it came with is not kept, unsigned or otherwise.
      if (!valid) throw new ConvexError("That ledger row’s signature doesn’t hold.");
      signed = true;
    }

    const container = projectId ? await containerFor(ctx, projectId, ownerId) : null;
    const workspaceId = container?.kind === "workspace" ? container.workspaceId : undefined;
    await ctx.db.insert("aiCalls", {
      ownerId,
      ...call,
      ...(workspaceId ? { workspaceId } : {}),
      ...(signed ? { signed: true } : {}),
      createdAt: now,
    });
    if (signed && workspaceId && call.costUsd) {
      const guest = !(await holdsSeat(ctx, workspaceId, ownerId));
      if (guest) await spendGuestDay(ctx, workspaceId, ownerId, utcDay(now), call.costUsd);
      await addPeriodSpend(ctx, workspaceId, ownerId, call.costUsd, guest);
    }
  },
});
