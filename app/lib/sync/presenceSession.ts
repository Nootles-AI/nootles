/**
 * How a tab's presence row survives the tab going away (NT-137).
 *
 * A refresh used to leave the old row behind: the websocket `presence.leave`
 * never ran, because the browser closes the socket in the same moment it is
 * sent, and the reloaded tab — a new provider with a new session id — saw its
 * own old row as somebody else, and drew its own caret back at itself until
 * the row went stale. Two things now close that:
 *
 * - **The goodbye goes by beacon.** `navigator.sendBeacon` outlives the page,
 *   so the row comes down as the tab goes, for everyone watching.
 * - **A refresh keeps its identity.** The leaving tab hands its session id to
 *   whichever page loads next in the same tab, through `sessionStorage`. That
 *   page reuses the row, so it never mistakes it for someone else's even if
 *   the beacon is lost, and its first heartbeat replaces it.
 *
 * The id is handed over only as the page goes (`pagehide`) and is taken — read
 * and removed — by the first provider that needs it. A live page therefore
 * never has one waiting in storage, which is what keeps "Duplicate tab" (it
 * copies `sessionStorage`) from giving two live tabs one row.
 */

const KEY = "nootles:presence-session:";

/**
 * A handover older than this is ignored. Past it the old row is stale to every
 * client anyway, so reusing its id buys nothing — and an old handover left in
 * storage is the only way two tabs could ever be given the same one.
 */
export const HANDOFF_TTL_MS = 30_000;

/** `sessionStorage`, or null where there is none or it refuses access. */
function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Leaves this tab's session id for the page that loads next in it. */
export function handOffSession(docId: string, sessionId: string) {
  try {
    storage()?.setItem(KEY + docId, JSON.stringify({ sessionId, at: Date.now() }));
  } catch {
    // Full or refused: the next page mints a fresh id, as before.
  }
}

/** Withdraws a handover — the page came back from the back/forward cache instead. */
export function withdrawSession(docId: string) {
  try {
    storage()?.removeItem(KEY + docId);
  } catch {
    // Nothing to withdraw from.
  }
}

/** The session id the previous page in this tab handed over for a doc, taken so nobody else gets it. */
export function takeSession(docId: string): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(KEY + docId);
    if (raw === null) return null;
    store.removeItem(KEY + docId);
    const { sessionId, at } = JSON.parse(raw) as { sessionId?: unknown; at?: unknown };
    if (typeof sessionId !== "string" || !sessionId || typeof at !== "number") return null;
    const age = Date.now() - at;
    return age >= 0 && age < HANDOFF_TTL_MS ? sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Sends the goodbye as the page goes, by beacon. True when the browser took
 * it; false when there is nowhere to send it or the browser declined, and the
 * caller should fall back to the websocket.
 *
 * It goes to the deployment's HTTP site, which the build names next to its
 * client URL (`convex deploy --cmd` sets both); without one there is no beacon.
 * The body is a string, so the beacon is text/plain — a simple request, with
 * no preflight to outlive.
 */
export function leaveByBeacon(leaving: { docId: string; sessionId: string; clientId: number }): boolean {
  const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (!site || typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }
  try {
    return navigator.sendBeacon(`${site.replace(/\/+$/, "")}/presence/leave`, JSON.stringify(leaving));
  } catch {
    return false;
  }
}
