import { AI } from "@/app/lib/ai/aiConfig";
import { streamFim } from "@/app/lib/ai/fim";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { refuseIfSpent } from "@/app/lib/entitlementGate";
import { sessionToken } from "@/app/lib/session";

/**
 * Inline completion. The caller sends the document split at the caret in the
 * Nootles HTML language, and Codestral fills the middle.
 *
 * Because the language is markup, "should this become a code block?" is not a
 * decision anyone has to make — a code block is simply what comes next in the
 * grammar. Mid-paragraph the closing tag is already in the suffix, so the model
 * emits bare text; at a boundary it closes the current element and opens the
 * next, exactly as it behaves in code.
 */
export async function POST(req: Request) {
  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  // Ahead of the model, not after it: the meter is charged when a suggestion is
  // KEPT, so this is the only place that stops a client streaming completions
  // it never accepts. See `entitlementGate`.
  const spent = await refuseIfSpent(token, "completions");
  if (spent) return spent;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { before, after, seed, mode } = (body ?? {}) as {
    before?: unknown;
    after?: unknown;
    seed?: unknown;
    mode?: unknown;
  };
  if (typeof before !== "string") {
    return new Response("`before` must be a string", { status: 400 });
  }

  // What the caller is completing INTO, which is what the budget is for.
  // "html" is the older spelling of "structure" and still arrives from the
  // code and math lanes.
  const shape =
    mode === "complete" ? "complete" : mode === "prose" ? "prose" : "structure";
  return streamFim(before, typeof after === "string" ? after : "", {
    maxTokens: AI.fim.maxTokens[shape],
    // Structure spans lines, so stopping at a newline would truncate a block
    // mid-way. Prose is a clause, and a line break is where it ends.
    ...(shape === "structure" ? { stop: "none" as const } : {}),
    // Its own field, never folded into `before`: the document is what gets
    // trimmed, and a seed that travelled inside it would be trimmed first.
    ...(typeof seed === "string" ? { seed } : {}),
    signal: req.signal,
    onDone: (r) =>
      recordAiCall(asUser(token), {
        feature: "fim",
        model: AI.fim.model,
        ...r.usage,
        latencyMs: r.latencyMs,
        ttfbMs: r.ttfbMs,
        status: r.status,
        errorCode: r.errorCode,
      }),
  });
}
