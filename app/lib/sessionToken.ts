/**
 * Longest one ask of Clerk's is waited on. Offline, Clerk takes about fifteen
 * seconds to give up on its own request; a stalled ask should not stretch the
 * back-off between attempts.
 */
export const TOKEN_ASK_TIMEOUT_MS = 8000;

const TOKEN_FIRST_MS = 500;
const REAUTH_FIRST_MS = 1000;
const LAST_MS = 30_000;

/**
 * A token, asked for again after each rejection, empty answer or stall, for as
 * long as Clerk still says this tab is signed in. Null only once it does not:
 * the session really has none.
 *
 * It waits rather than giving up because of what giving up costs. Convex drops
 * the connection's identity the first time a fetch comes back empty, and every
 * query then answers as nobody, which a page reads as "no access". Waiting
 * leaves the identity in place. When the server has already refused the old
 * token, Convex stops the socket before it asks, so the tab keeps what it last
 * read and queues what is written, like any offline tab, until Clerk answers.
 *
 * `onWait` hears true after the first ask that fails and false when the wait
 * ends, so the tab can say it is reconnecting.
 */
export async function patientToken(
  ask: () => Promise<string | null>,
  {
    signedIn,
    onWait,
    delay = tokenDelay,
    timeoutMs = TOKEN_ASK_TIMEOUT_MS,
  }: {
    signedIn: () => boolean;
    onWait?: (waiting: boolean) => void;
    delay?: (attempt: number) => number;
    timeoutMs?: number;
  },
): Promise<string | null> {
  let waited = false;
  try {
    for (let attempt = 0; ; attempt++) {
      const token = await within(ask, timeoutMs);
      if (token) return token;
      if (!signedIn()) return null;
      if (!waited) {
        waited = true;
        onWait?.(true);
      }
      await sleep(delay(attempt));
      if (!signedIn()) return null;
    }
  } finally {
    if (waited) onWait?.(false);
  }
}

/** Doubling from half a second, capped at thirty: a blip is over at once. */
export function tokenDelay(attempt: number): number {
  return Math.min(TOKEN_FIRST_MS * 2 ** attempt, LAST_MS);
}

async function within(ask: () => Promise<string | null>, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ask(),
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms))),
    ]);
  } catch {
    // Clerk throws when its request never came back; that is no answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks after which a tab that Convex keeps refusing stops asking on a timer
 * and says so: past a handful, the refusal is the server's answer, not a blip.
 */
export const REAUTH_GIVE_UP_AFTER = 5;

/**
 * How long a tab that Clerk still has signed in, but Convex no longer does,
 * waits before asking Convex to take a token again: doubling from a second,
 * so a blip is over at once and an outage is not hammered.
 */
export function reauthDelay(attempt: number): number {
  return Math.min(REAUTH_FIRST_MS * 2 ** attempt, LAST_MS);
}

export type Reauth = {
  /** `asked` as of the last time Convex held a token. */
  held: number;
  /** Asks made since, in this outage. */
  tries: number;
  /** Clerk has a session and Convex has settled on not taking it. */
  dropped: boolean;
  /** Enough asks have been refused that another on a timer is pointless. */
  stuck: boolean;
};

/**
 * Where the asking stands for one render of `Reauthenticate`. `held` catches
 * up to `asked` whenever Convex is authenticated, so the asks it counts are
 * this outage's alone.
 */
export function reauthState({
  asked,
  held,
  isSignedIn,
  isLoading,
  isAuthenticated,
}: {
  asked: number;
  held: number;
  isSignedIn: boolean | undefined;
  isLoading: boolean;
  isAuthenticated: boolean;
}): Reauth {
  const since = isAuthenticated ? asked : held;
  const tries = asked - since;
  const dropped = isSignedIn === true && !isLoading && !isAuthenticated;
  return { held: since, tries, dropped, stuck: dropped && tries >= REAUTH_GIVE_UP_AFTER };
}
