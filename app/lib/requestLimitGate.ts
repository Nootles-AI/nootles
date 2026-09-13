import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { isRateRefusal, type Bucket } from "@/convex/requestLimits";

/**
 * The rate gate on the API routes: refuse a burst before the model key is spent.
 *
 * The sibling of `entitlementGate.ts`, and the same division of labour the
 * server keeps between `convex/requestLimits.ts` and `convex/entitlements.ts`.
 * Entitlement answers whether the account may do this at all and refuses with
 * `402` and an upgrade; this answers whether it is going too fast and refuses
 * with `429` and a time to come back. The two stay distinct status codes so a
 * client — and the chat transcript — can tell a wall it must pay to pass from
 * one it need only wait out.
 *
 * The decision is the Convex mutation's; this only turns it into an HTTP answer.
 * Under `observe` and `off` the mutation ADMITS — it returns rather than throws,
 * even when it would have refused — so this returns null and the route proceeds,
 * which is what lets the ceilings be measured against real traffic before they
 * bite. Under `enforce` a refusal throws, and becomes the `429`. A limiter that
 * is broken rather than refusing throws something that is not a refusal, and
 * becomes `503` — never a silent pass into an unbounded provider call.
 *
 * The caller passes the Convex client it already holds — `asUser` for a route
 * that lives inside one token, `asSession` for the chat loop that outlives one
 * — so the subject the limit is keyed to is the caller's, derived server-side
 * inside `consume`, and never anything a request body could name.
 */

/** Whole seconds, rounded up and never zero: a client that waits `0` loops. */
function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/**
 * `429`, the bucket that refused, and how long to wait. The JSON body is the
 * contract a fetch-based caller branches on; the `Retry-After` header is the
 * same fact in the form the platform and the browser already understand.
 */
function rateLimitResponse(bucket: Bucket, retryAfterMs: number): Response {
  return new Response(JSON.stringify({ code: "rate_limit", bucket, retryAfterMs }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

/**
 * `503`, kept deliberately distinct from both the `429` above and the `402` the
 * entitlement gate returns: the limiter being down is an infrastructure fault,
 * not a decision about this caller, and a client must not read it as either a
 * rate wall to wait out or an allowance to pay past.
 */
function limiterUnavailableResponse(): Response {
  return new Response(JSON.stringify({ code: "limiter_unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The whole gate in one call: `null` to proceed, or the response to return.
 *
 * Placed after authentication and after the cheap structural validation a
 * request must pass anyway, and before any paid or external work — so a refused
 * request has cost nothing, and a malformed one is turned away without spending
 * a token on it.
 */
export async function refuseIfLimited(
  convex: ConvexHttpClient,
  bucket: Bucket,
): Promise<Response | null> {
  try {
    await convex.mutation(api.requestLimits.consume, { bucket });
    return null;
  } catch (error) {
    if (isRateRefusal(error)) {
      return rateLimitResponse(error.data.bucket, error.data.retryAfterMs);
    }
    return limiterUnavailableResponse();
  }
}
