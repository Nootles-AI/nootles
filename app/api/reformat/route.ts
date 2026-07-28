import { reformatCandidates } from "@/app/lib/ai/reformat";

/**
 * Reformat suggestions for one finished block. The caller sends the block in
 * the auto-board HTML language; the model returns the shapes that block could
 * take, each as rewritten HTML carrying the same id — which is what lets the
 * compiler treat the result as a replacement rather than an insertion.
 */
export async function POST(req: Request) {
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

  try {
    const candidates = await reformatCandidates(block, req.signal);
    return Response.json({ candidates });
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    return new Response("Upstream request failed", { status: 502 });
  }
}
