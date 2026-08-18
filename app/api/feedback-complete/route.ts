import { AI } from "@/app/lib/ai/aiConfig";
import { completeFeedback } from "@/app/lib/ai/feedbackComplete";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { sessionToken } from "@/app/lib/session";

/** Ghost-text continuation for the feedback form. Best-effort and cheap. */
export async function POST(req: Request) {
  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { text, kind, ops, consoleTail } = (body ?? {}) as {
    text?: unknown;
    kind?: unknown;
    ops?: unknown;
    consoleTail?: unknown;
  };
  if (typeof text !== "string" || !text.trim()) {
    return new Response("`text` must be a non-empty string", { status: 400 });
  }

  const started = Date.now();
  try {
    const { completion, usage, failure } = await completeFeedback(
      {
        text,
        kind: kind === "wish" ? "wish" : "issue",
        ...(typeof ops === "string" ? { ops } : {}),
        ...(typeof consoleTail === "string" ? { consoleTail } : {}),
      },
      req.signal,
    );
    recordAiCall(asUser(token), {
      feature: "feedback",
      model: AI.reformat.model,
      ...usage,
      latencyMs: Date.now() - started,
      // See the reformat route's note: no ghost text is a fine answer, and a
      // refused call is not one.
      ...(failure ? { status: "error" as const, errorCode: failure } : { status: "ok" as const }),
    });
    return Response.json({ completion });
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    return Response.json({ completion: "" });
  }
}
