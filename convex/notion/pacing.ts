import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { NotionError } from "./rest";

/**
 * The queue a Notion connection's requests wait their turn in.
 *
 * Notion budgets each connection — 180 requests a minute on most plans — and
 * asks for a connection's requests to go through one queue, so a burst from
 * one job cannot spend the budget another is relying on. Everything that reads
 * a workspace comes through here: the wizard's walk, a link followed from a
 * page, and a walk still running for a follow its reader has closed. Spacing
 * kept in the action's own module only ever spaced the requests that module
 * instance made; two invocations — two tabs, or a closed menu and the next
 * link — each kept their own clock, and together they overspent the budget.
 *
 * The rate limiter's reservation is that queue: a turn per request, one turn
 * every MIN_REQUEST_GAP_MS and none saved up, so a caller is handed the next
 * free turn and told how long to wait for it. Its state is a row per
 * connection, written in a transaction, so no two callers get the same turn.
 */

/** Notion's published average is three a second; this stays under it. */
export const MIN_REQUEST_GAP_MS = 350;

const queue = new RateLimiter(components.rateLimiter, {
  notionRequest: { kind: "token bucket", rate: 1, period: MIN_REQUEST_GAP_MS, capacity: 1 },
});

/** One request to Notion, sent in its connection's turn. */
export type Paced = <T>(call: () => Promise<T>) => Promise<T>;

/**
 * A connection's requests, each in its turn, and retried once when Notion
 * says to wait.
 *
 * A 429 is not a failure worth surfacing: Notion tells us how long to wait,
 * and the wait belongs to the connection, not to the request that heard it.
 * So it is taken out of the queue as turns nobody gets, and every caller
 * behind it waits too instead of spending the budget the retry needs. Anything
 * past one retry is a real problem and travels up as a `NotionError` the UI
 * can show.
 */
export function pacer(ctx: Pick<ActionCtx, "runQuery" | "runMutation">, ownerId: string): Paced {
  const turn = async (turns: number) => {
    const { retryAfter } = await queue.limit(ctx, "notionRequest", {
      key: ownerId,
      count: turns,
      reserve: true,
    });
    if (retryAfter) await sleep(retryAfter);
  };
  return async (call) => {
    await turn(1);
    try {
      return await call();
    } catch (error) {
      if (error instanceof NotionError && error.status === 429) {
        // Notion says how long to wait; guessing shorter just earns another
        // 429. The retry's own turn comes after all of it.
        await turn(1 + ((error.retryAfter ?? 5) * 1000) / MIN_REQUEST_GAP_MS);
        return await call();
      }
      throw error;
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
