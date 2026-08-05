import { AI } from "@/app/lib/ai/aiConfig";
import { streamFim } from "@/app/lib/ai/fim";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
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

  const html = mode === "html";
  return streamFim(before, typeof after === "string" ? after : "", {
    // Structure spans lines, so stopping at a newline would truncate a block
    // mid-way. Plain prose stays short because the suffix bounds it.
    maxTokens: html ? AI.fim.htmlMaxTokens : AI.fim.ghostMaxTokens,
    stop: html ? [] : undefined,
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
