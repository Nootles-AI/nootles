import { AI } from "@/app/lib/ai/aiConfig";
import { reformatCandidates } from "@/app/lib/ai/reformat";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { sessionToken } from "@/app/lib/session";

/**
 * Reformat suggestions for one finished block. The caller sends the block in
 * the Nootles HTML language; the model returns the shapes that block could
 * take, each as rewritten HTML carrying the same id — which is what lets the
 * compiler treat the result as a replacement rather than an insertion.
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

  const { block } = (body ?? {}) as { block?: unknown };
  if (typeof block !== "string" || !block.trim()) {
    return new Response("`block` must be a non-empty string", { status: 400 });
  }

  const started = Date.now();
  try {
    const { candidates, usage, failure } = await reformatCandidates(block, req.signal);
    recordAiCall(asUser(token), {
      feature: "reformat",
      model: AI.reformat.model,
      ...usage,
      latencyMs: Date.now() - started,
      // The user gets the same quiet 200 either way — an ambient suggestion has
      // no business raising an error at someone who did not ask for it — but a
      // lane that answered nothing because the wire refused is not an `ok` call,
      // and recording it as one is how this went unnoticed for six weeks.
      ...(failure ? { status: "error" as const, errorCode: failure } : { status: "ok" as const }),
    });
    return Response.json({ candidates });
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    recordAiCall(asUser(token), {
      feature: "reformat",
      model: AI.reformat.model,
      latencyMs: Date.now() - started,
      status: aborted ? "aborted" : "error",
      ...(aborted ? {} : { errorCode: "fetch-failed" }),
    });
    if (aborted) return new Response(null, { status: 204 });
    return new Response("Upstream request failed", { status: 502 });
  }
}
