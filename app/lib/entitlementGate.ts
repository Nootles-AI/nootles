import { api } from "@/convex/_generated/api";
import type { Meter, RefusedMeter, Standing } from "@/convex/entitlements";
import { guestDaySpent } from "@/convex/plans";
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
 * `entitlements.forContainer` and stops asking the moment the allowance is gone. So it
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
const cache = new Map<string, { at: number; standing: Standing | null }>();

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
 * One session's answer for one project. The project is part of the key because
 * it decides the container — the same person is on their own allowance in one
 * project and on a workspace's in the next — and a session's answer for one
 * must never stand in for the other. No project is the caller's own account.
 */
const keyOf = (token: string, projectId?: string) =>
  projectId ? `${token} ${projectId}` : token;

/**
 * What governs the caller's work in `projectId` — or their own account,
 * without one — cached for `TTL_MS`.
 *
 * Keyed by the session token, which is per-session and short-lived — so this
 * never becomes a store of identities, and a signed-out session's entry ages
 * out on its own.
 */
export async function standingFor(
  token: string,
  projectId?: string,
): Promise<Standing | null> {
  const now = Date.now();
  const key = keyOf(token, projectId);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.standing;
  const standing = await asUser(token).query(
    api.entitlements.forContainer,
    projectId ? { projectId } : {},
  );
  prune(now);
  cache.set(key, { at: now, standing });
  return standing;
}

/** Forget one session's cached answers, or all of them. */
export function forgetStanding(token?: string): void {
  if (!token) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key === token || key.startsWith(`${token} `)) cache.delete(key);
  }
}

/**
 * 402, and the meter that ran out. The status is the point: it is the one code
 * that means "this needs paying for", so a client can branch on it without
 * reading the body, and nothing here can be mistaken for a transient failure
 * worth retrying.
 */
export function quotaResponse(meter: RefusedMeter): Response {
  return new Response(JSON.stringify({ code: "quota", meter }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The whole gate in one call: `null` to proceed, or the response to return.
 * `meter` is the allowance the work spends, if it spends one; a guest's day of
 * a workspace's AI is asked whatever the work. `projectId` is the project the
 * work is for, as the request named it; Convex decides whether that makes it
 * a workspace's, and whether the caller is a guest there, so naming one proves
 * nothing.
 *
 * A failed lookup proceeds. The allowance is enforced transactionally in
 * Convex either way, and refusing everybody's completions because one query
 * timed out would turn a blip into an outage.
 */
export async function refuseIfSpent(
  token: string,
  meter: Meter | null,
  projectId?: string,
): Promise<Response | null> {
  // Off a project there is no guest, and without a meter nothing else to ask.
  if (!meter && !projectId) return null;
  const standing = await standingFor(token, projectId).catch(() => null);
  if (!standing) return null;
  if (guestDaySpent(standing.guestAi, Date.now())) return quotaResponse("guestAi");
  const left = standing.entitlement.left;
  return meter && left && left[meter] <= 0 ? quotaResponse(meter) : null;
}
