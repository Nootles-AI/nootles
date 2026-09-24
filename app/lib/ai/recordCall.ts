import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { ledgerSecret, signCall } from "@/convex/ai/callSignature";
import { AI } from "./aiConfig";

/**
 * The LLM ledger's write path. Every API route records each model call here
 * after its stream ends — fire-and-forget, never blocking or failing the
 * response the user is waiting on.
 */

export type CallUsage = {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export function costUsd(model: string, u: CallUsage): number | undefined {
  const p = AI.prices[model];
  // Per-image models charge the call, not the tokens — the usage block may be
  // empty and the price still whole.
  if (p?.perCall !== undefined) return p.perCall;
  if (u.promptTokens === undefined && u.completionTokens === undefined)
    return undefined;
  if (!p) return undefined;
  const read = u.cacheReadTokens ?? 0;
  const wrote = u.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, (u.promptTokens ?? 0) - read - wrote);
  return (
    (fresh * p.in +
      (u.completionTokens ?? 0) * p.out +
      read * (p.cacheRead ?? p.in) +
      wrote * (p.cacheWrite ?? p.in)) /
    1_000_000
  );
}

type Row = {
  feature:
    | "fim"
    | "reformat"
    | "diagram"
    | "chat"
    | "categorize"
    | "feedback"
    | "album"
    | "context"
    | "commentsGate";
  model: string;
  latencyMs: number;
  ttfbMs?: number;
  status: "ok" | "error" | "aborted" | "timeout";
  errorCode?: string;
  /**
   * The project the call was made in, when the route knows it. Convex
   * resolves the workspace it is charged to from this, never the route.
   */
  projectId?: string;
  costUsd?: number;
} & CallUsage;

/**
 * What lets Convex bill the row (`convex/ai/callSignature.ts`), or nothing on
 * a server without `AI_LEDGER_SECRET` — the row is still kept, unsigned.
 */
async function signatureFor(
  ownerId: string | null,
  row: Row,
): Promise<{ signedAt: number; signature: string } | Record<string, never>> {
  const secret = ledgerSecret(process.env.AI_LEDGER_SECRET);
  if (!secret || !ownerId) return {};
  const signedAt = Date.now();
  return { signedAt, signature: await signCall(secret, { ownerId, ...row, signedAt }) };
}

export function recordAiCall(
  convex: ConvexHttpClient,
  {
    ownerId,
    ...call
  }: Omit<Row, "costUsd"> & {
    /**
     * Who made the call: the session's Clerk user id, which is the subject
     * Convex reads off the same session's token. The signature binds the row
     * to it, so it must be the session's own — never anything a request said.
     */
    ownerId: string | null;
  },
): void {
  const row: Row = { ...call, costUsd: costUsd(call.model, call) };
  void signatureFor(ownerId, row)
    .then((signature) => convex.mutation(api.ai.calls.record, { ...row, ...signature }))
    .catch((error: unknown) => {
      // Never the user's problem, but never silent either: a row that fails to
      // land is a cost nobody sees, and this once hid a token expiring under a
      // 62-second request for a whole evening.
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[ledger] ${call.feature} row not recorded:`, error);
      }
    });
}
