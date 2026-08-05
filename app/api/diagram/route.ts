import { AI } from "@/app/lib/ai/aiConfig";
import { streamDiagram } from "@/app/lib/ai/diagram";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { sessionToken } from "@/app/lib/session";

/**
 * Expands one `<nt-build-diagram>` into canvas HTML.
 *
 * The second half of the completion lane: stage one decides, in the grammar,
 * that a diagram comes next and says in a phrase what it is for; this turns
 * that phrase into shapes. Streamed as plain text so the caller can draw the
 * diagram as it arrives.
 */
export const maxDuration = 60;

export async function POST(req: Request) {
  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { brief, page, title } = (body ?? {}) as {
    brief?: unknown;
    page?: unknown;
    title?: unknown;
  };
  if (typeof brief !== "string" || !brief.trim()) {
    return new Response("`brief` must be a non-empty string", { status: 400 });
  }

  try {
    return streamDiagram(
      brief,
      typeof page === "string" ? page : "",
      typeof title === "string" ? title : "",
      req.signal,
      ({ usage, latencyMs }) =>
        recordAiCall(asUser(token), {
          feature: "diagram",
          model: AI.diagram.model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
          cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
          latencyMs,
          status: req.signal.aborted ? "aborted" : "ok",
        }),
    );
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    return new Response("Upstream request failed", { status: 502 });
  }
}
