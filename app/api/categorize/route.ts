import { AI } from "@/app/lib/ai/aiConfig";
import { categorizeFeedback } from "@/app/lib/ai/categorize";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { session } from "@/app/lib/session";

/**
 * Suggests a category for a feedback report as it is being written. Cheap and
 * best-effort: the form falls back to "general" and the select stays in the
 * user's hands either way.
 */
export async function POST(req: Request) {
  const caller = await session();
  if (!caller) return new Response("Unauthorized", { status: 401 });
  const { token } = caller;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { text, ops, consoleTail, projectId } = (body ?? {}) as {
    text?: unknown;
    ops?: unknown;
    consoleTail?: unknown;
    projectId?: unknown;
  };
  if (typeof text !== "string" || !text.trim()) {
    return new Response("`text` must be a non-empty string", { status: 400 });
  }

  const started = Date.now();
  try {
    const { category, usage, failure } = await categorizeFeedback(
      {
        text,
        ...(typeof ops === "string" ? { ops } : {}),
        ...(typeof consoleTail === "string" ? { consoleTail } : {}),
      },
      req.signal,
    );
    recordAiCall(asUser(token), {
      ownerId: caller.userId,
      feature: "categorize",
      model: AI.reformat.model,
      // The report is filed from a project, when it is, and so is its cost.
      projectId: typeof projectId === "string" ? projectId : undefined,
      ...usage,
      latencyMs: Date.now() - started,
      // "general" is both a real guess and the fallback, so only the row can say
      // whether the model chose it. See the reformat route's note.
      ...(failure ? { status: "error" as const, errorCode: failure } : { status: "ok" as const }),
    });
    return Response.json({ category });
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    return Response.json({ category: "general" });
  }
}
