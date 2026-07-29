import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isToolUIPart,
  stepCountIs,
  streamText,
  toUIMessageStream,
} from "ai";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { downloadAttachments } from "@/app/lib/ai/chat/download";
import { convertDataPart } from "@/app/lib/ai/chat/parts";
import { chatModel } from "@/app/lib/ai/chat/provider";
import { OUT_OF_STEPS, SYSTEM, openPageNote } from "@/app/lib/ai/chat/prompt";
import { chatTools } from "@/app/lib/ai/chat/serverTools";
import { ASK_TOOLS } from "@/app/lib/ai/chat/tools";
import type { AbMessage, ChatMode } from "@/app/lib/ai/chat/types";

/**
 * The chat agent's loop.
 *
 * The model runs here, on the server, because the API key must stay here. Tools
 * that touch the document are declared WITHOUT an `execute`, which ends the
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

  const { messages, projectId, pageId, mode } = (body ?? {}) as {
    messages?: AbMessage[];
    projectId?: Id<"projects">;
    pageId?: Id<"pages">;
    mode?: ChatMode;
  };
  if (!Array.isArray(messages)) {
    return new Response("`messages` must be an array", { status: 400 });
  }
  if (!projectId) {
    return new Response("`projectId` is required", { status: 400 });
  }

  // A call whose result never arrived — an abandoned turn, a closed tab — is
  // dropped rather than sent. Providers reject an unanswered call, which would
  // otherwise fail every later message in the thread and not just that one.
  //
  // `convertDataPart` is where a mention and an attached text file become
  // something the model reads; without it they are UI and nothing more.
  // Named explicitly: inference reads `Omit<UI_MESSAGE, "id">` and falls back to
  // the base message, which has no data parts for `convertDataPart` to convert.
  const conversation = await convertToModelMessages<AbMessage>(messages, {
    ignoreIncompleteToolCalls: true,
    convertDataPart,
  });

  // A turn that has spent its budget gets one last step with no tools, which is
  // what ends it: an answer from what it has, rather than another call it cannot
  // afford. Never on the request carrying an answered approval, though: the
  // nudge goes after the tool message, and the SDK reads approval responses off
  // the last message only, so appending anything discards the user's answer and
  // the call is neither run nor denied. Running it costs no step — it happens
  // before the first one — so the nudge simply lands on the next request.
  const budget = AI.chat.maxSteps - stepsTaken(messages);
  const spent = budget <= 0 && !answeringApproval(messages);

  const result = streamText({
    model: chatModel(),
    system: SYSTEM + openPageNote(pageId),
    messages: spent
      ? [...conversation, { role: "user", content: OUT_OF_STEPS }]
      : conversation,
    tools: chatTools(projectId),
    // Ask is a promise the user can see: the tools that could change something
    // are not merely discouraged, they are absent from the request.
    activeTools: spent ? [] : mode === "ask" ? ASK_TOOLS : undefined,
    stopWhen: stepCountIs(Math.max(1, budget)),
    experimental_download: downloadAttachments,
    abortSignal: req.signal,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}

/**
 * How much of the turn's step budget is already spent.
 *
 * A tool the browser answers ends the request that carried it, and the browser
 * resumes the turn with a new one — where `streamText` starts counting steps
 * again at zero. The turn itself is the assistant message being continued
 * across those requests, one `step-start` per step it has taken.
 */
function stepsTaken(messages: AbMessage[]): number {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return 0;
  return last.parts.filter((part) => part.type === "step-start").length;
}

/**
 * Whether the turn is being resumed with a call the user has allowed or refused
 * and that has yet to run. `approval-responded` is exactly that window: the
 * answer is in, the outcome is not.
 */
function answeringApproval(messages: AbMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return false;
  return last.parts.some(
    (part) => isToolUIPart(part) && part.state === "approval-responded",
  );
}
