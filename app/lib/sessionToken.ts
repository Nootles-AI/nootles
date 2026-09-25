/**
 * Waits before each retry of a token Clerk did not hand over. Convex asks for
 * the next token ten seconds before the current one runs out, and the first
 * ask that comes back empty drops the connection's identity for good — every
 * query answers as nobody until something asks again. One lost request would
 * otherwise sign a working tab out; the retries fit inside that leeway.
 */
export const TOKEN_RETRY_DELAYS_MS = [500, 1500, 4000];

/**
 * A token, asked for again after each delay while the answer is a rejection
 * or nothing. Null once the delays run out: the session really has none.
 */
export async function patientToken(
  ask: () => Promise<string | null>,
  delays: readonly number[] = TOKEN_RETRY_DELAYS_MS,
): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const token = await ask();
      if (token) return token;
    } catch {
      // Clerk throws when its request never came back; that is no answer.
    }
    if (attempt === delays.length) return null;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}

const REAUTH_FIRST_MS = 1000;
const REAUTH_LAST_MS = 30_000;

/**
 * How long a tab that Clerk still has signed in, but Convex no longer does,
 * waits before asking Convex to take a token again: doubling from a second,
 * so a blip is over at once and an outage is not hammered.
 */
export function reauthDelay(attempt: number): number {
  return Math.min(REAUTH_FIRST_MS * 2 ** attempt, REAUTH_LAST_MS);
}
