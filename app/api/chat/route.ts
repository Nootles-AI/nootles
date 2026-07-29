import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { AI } from "@/app/lib/ai/aiConfig";
import { chatModel } from "@/app/lib/ai/chat/provider";
import { SYSTEM } from "@/app/lib/ai/chat/prompt";

/**
 * The chat agent's loop.
 *
 * The model runs here, on the server, because the API key must stay here. Tools
 * that touch the document will be declared WITHOUT an `execute`, which ends the
 * step and streams the call to the browser — the applier needs the live editor
 * instance, so the document is only ever mutated client-side, through the same
 * path a human edit takes.
 */
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { messages } = (body ?? {}) as { messages?: UIMessage[] };
  if (!Array.isArray(messages)) {
    return new Response("`messages` must be an array", { status: 400 });
  }

  const result = streamText({
    model: chatModel(),
    system: SYSTEM,
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(AI.chat.maxSteps),
    abortSignal: req.signal,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
