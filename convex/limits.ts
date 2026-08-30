/**
 * What a free account gets, once, ever — and nothing else.
 *
 * Split out of `entitlements.ts` because the client needs these numbers to draw
 * the allowance, and importing them from that module drags its `mutation` and
 * `query` registrations into the browser bundle. Convex warns about exactly
 * that, and is right to: the browser would be evaluating server function
 * definitions to read three integers.
 *
 * Constants and types only. Nothing here may import from `_generated`, and
 * nothing here may register a function — that property is the whole point of
 * the file, and it is what makes it safe on both sides.
 */

export const FREE_LIMITS = {
  /**
   * Total live projects, which is the tutorial's seeded project plus one of
   * their own. Someone who skipped the tutorial never got the seeded one and
   * so makes two — the honest reading of a total, and much better than
   * refusing a skipper their first project to keep an arithmetic tidy.
   */
  projects: 2,
  /** Suggestions ACCEPTED. Offers cost the user nothing and are not counted. */
  completions: 100,
  /** Conversations that actually reached the model. See `chatThreads.billedAt`. */
  chats: 10,
} as const;

export type Meter = keyof typeof FREE_LIMITS;
