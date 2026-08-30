import { api } from "@/convex/_generated/api";
import type { Entitlement, Meter } from "@/convex/entitlements";
import { asUser } from "./convexServer";

/**
 * The cost guard on the API routes: refuse before the model key is spent.
 *
 * The meters themselves are charged in Convex, where they are transactional.
 * This is the other half — the one that matters for money. A completion is
 * charged only when it is ACCEPTED, so nothing on the accept path can stop a
 * client that streams a thousand suggestions and keeps none of them. Only a
 * check here, ahead of the call, can.
 *
 * It is a backstop rather than the primary UI: the app subscribes to
 * `entitlements.mine` and stops asking the moment the allowance is gone. So it
 * can afford to answer from a short-lived cache, which is what keeps it off the
 * critical path of ambient completion — that lane fires at typing cadence, and
 * a Convex round trip per keystroke window is latency nobody agreed to pay.
 */

/**
 * Long enough to make the cache worth having across one burst of typing, short
 * enough that an upgrade is honoured within seconds without anything having to
 * remember to invalidate it. `forget` handles the cases where seconds is still
 * too slow — redeeming a code, returning from checkout.
 */
const TTL_MS = 30_000;

/** Far past one person's concurrent sessions; a bound, not a working size. */
const MAX_ENTRIES = 500;

/**
 * `null` is the deployment saying nobody is signed in under that token — which
 * is cached like any other answer, since a token that stopped resolving will
 * not start again inside thirty seconds.
 */
const cache = new Map<string, { at: number; entitlement: Entitlement | null }>();

/** Drops what has expired, and the oldest entries if the map is still over. */
function prune(now: number): void {
  for (const [key, hit] of cache) {
    if (now - hit.at >= TTL_MS) cache.delete(key);
  }
  if (cache.size <= MAX_ENTRIES) return;
  // Insertion order is age order — Map iterates oldest first.
  for (const key of cache.keys()) {
    if (cache.size <= MAX_ENTRIES) break;
    cache.delete(key);
  }
}

/**
 * The caller's entitlement, cached for `TTL_MS`.
 *
 * Keyed by the session token, which is per-session and short-lived — so this
 * never becomes a store of identities, and a signed-out session's entry ages
 * out on its own.
 */
export async function entitlementFor(token: string): Promise<Entitlement | null> {
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < TTL_MS) return hit.entitlement;
  const entitlement = await asUser(token).query(api.entitlements.mine, {});
  prune(now);
  cache.set(token, { at: now, entitlement });
  return entitlement;
}

/** Forget one session's cached answer, or all of them. */
export function forgetEntitlement(token?: string): void {
  if (token) cache.delete(token);
  else cache.clear();
}

/**
 * 402, and the meter that ran out. The status is the point: it is the one code
 * that means "this needs paying for", so a client can branch on it without
 * reading the body, and nothing here can be mistaken for a transient failure
 * worth retrying.
 */
export function quotaResponse(meter: Meter): Response {
  return new Response(JSON.stringify({ code: "quota", meter }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The whole gate in one call: `null` to proceed, or the response to return.
 *
 * A failed lookup proceeds. The allowance is enforced transactionally in
 * Convex either way, and refusing everybody's completions because one query
 * timed out would turn a blip into an outage.
 */
export async function refuseIfSpent(
  token: string,
  meter: Meter,
): Promise<Response | null> {
  const entitlement = await entitlementFor(token).catch(() => null);
  if (!entitlement || entitlement.left === null) return null;
  return entitlement.left[meter] > 0 ? null : quotaResponse(meter);
}
