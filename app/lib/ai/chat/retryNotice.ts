const RESETS = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Also what the panel says when it knows ahead of sending. The day is the
 * UTC day the server counts, said at the reader's own clock — and on their
 * own calendar, where the reset often falls tomorrow.
 */
export function guestDaySpent(now: Date = new Date()): string {
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const day = resets.toDateString() === now.toDateString() ? "today" : "tomorrow";
  return (
    `You’ve used your guest AI allowance for the day. It resets ${day} at ${RESETS.format(resets)}. ` +
    "Members of the workspace have no daily limit — ask the person who shared this project to invite you."
  );
}

/**
 * A rate or infrastructure refusal, as a line to show the person who hit it.
 *
 * The chat transport throws the response body as the error's message, so the
 * gate's `429` arrives here as the JSON it wrote. Turned into a sentence with a
 * count of seconds; a `503` becomes a briefer "try again" with no promised time,
 * because there is none to promise. A guest's spent day of a workspace's AI —
 * the one `402` with no wall to raise, since nothing the guest can buy lifts
 * it — says when it opens again. A `403` from `beginChat` says the person can
 * no longer edit the project, or no longer open it. Anything else — a real
 * stream error, a meter's `402`, which the panel walls ahead of sending —
 * returns null and is shown as it was.
 *
 * This is the whole of the recovery. A refusal happens before the turn is billed
 * and before the model is called, and the user's message was written to the
 * thread before the request left — so it is still on screen and still in the
 * database, and the only thing missing is the answer. Wait the stated time and
 * send again; nothing was spent, duplicated, or lost.
 */
export function retryNotice(message: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;

  const code = (data as { code?: unknown }).code;
  if (code === "quota" && (data as { meter?: unknown }).meter === "guestAi") {
    return guestDaySpent();
  }
  if (code === "chat_refused") {
    return (data as { reason?: unknown }).reason === "gone"
      ? "This project is no longer open to you — it may have been moved to the trash, or your access ended."
      : "You can no longer edit this project, so the assistant can’t work in it. Ask whoever shared it for edit access.";
  }
  if (code === "limiter_unavailable") {
    return "The assistant is briefly unavailable. Try again in a moment.";
  }
  if (code !== "rate_limit") return null;

  const ms = (data as { retryAfterMs?: unknown }).retryAfterMs;
  const seconds = typeof ms === "number" && ms > 0 ? Math.ceil(ms / 1000) : 1;
  return `You're sending messages too quickly. Try again in ${seconds} second${
    seconds === 1 ? "" : "s"
  }.`;
}
