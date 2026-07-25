import { streamFim } from "@/app/lib/ai/fim";

/**
 * Ghost-text completion via Mistral Codestral's fill-in-the-middle endpoint.
 * FIM sees the text before AND after the caret and returns a raw continuation —
 * no chat wrapper, no leading-space stripping, sub-200ms first token. The client
 * aborts on each keystroke; `req.signal` propagates upstream so a superseded
 * completion stops at once.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { before, after } = (body ?? {}) as { before?: unknown; after?: unknown };
  if (typeof before !== "string") {
    return new Response("`before` must be a string", { status: 400 });
  }

  return streamFim(before, typeof after === "string" ? after : "", {
    maxTokens: 32,
    signal: req.signal,
  });
}
