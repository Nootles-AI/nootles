/**
 * What a first visit learns of its address: `answered` false when neither the
 * server nor Clerk behind it said anything, which is not the same as there
 * being no address to say.
 */
export type Confirmation = { email: string | null; answered: boolean };

/**
 * Waits before each retry. The server holds an unanswered ask for five
 * seconds, so the first retry catches a call lost on the way back, and the
 * second is the one that asks Clerk again.
 */
export const RETRY_DELAYS_MS = [2000, 8000];

/**
 * Asks, and asks again after each delay while there is no answer — a
 * rejection, whether the server's "unanswered" or a connection dropped
 * mid-call, is none. Undefined when `signal` aborts first: whoever asked has
 * moved on.
 */
export async function confirmEmail(
  ask: () => Promise<string | null>,
  signal: AbortSignal,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<Confirmation | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const email = await ask();
      return signal.aborted ? undefined : { email, answered: true };
    } catch {
      if (signal.aborted) return undefined;
    }
    if (attempt === delays.length) return { email: null, answered: false };
    if (!(await wait(delays[attempt], signal))) return undefined;
  }
}

/** False when aborted before `ms` had passed. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}
