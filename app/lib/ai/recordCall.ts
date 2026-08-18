import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
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

export function recordAiCall(
  convex: ConvexHttpClient,
  call: {
    feature: "fim" | "reformat" | "diagram" | "chat" | "categorize" | "feedback";
    model: string;
    latencyMs: number;
    ttfbMs?: number;
    status: "ok" | "error" | "aborted" | "timeout";
    errorCode?: string;
  } & CallUsage,
): void {
  void convex
    .mutation(api.ai.calls.record, { ...call, costUsd: costUsd(call.model, call) })
    .catch(() => {});
}
