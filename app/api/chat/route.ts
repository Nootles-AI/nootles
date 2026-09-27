import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isToolUIPart,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { downloadAttachments } from "@/app/lib/ai/chat/download";
import { drawChoiceSchema } from "@/app/lib/ai/drawStyles";
import { convertDataPart } from "@/app/lib/ai/chat/parts";
import { chatModel } from "@/app/lib/ai/chat/provider";
import { ATTACHED, OUT_OF_STEPS, SYSTEM, openPageNote } from "@/app/lib/ai/chat/prompt";
import { commentsPack, pagePack, projectPack } from "@/app/lib/ai/context/pack";
import { commentsGate } from "@/app/lib/ai/commentsGate";
import { gateSummary, parseDigest, type CommentsDigest } from "@/app/lib/comments/digest";
import { chatTools } from "@/app/lib/ai/chat/serverTools";
import {
  cached,
  foldResearch,
  markCachePoints,
  shortenStaleReads,
  stripDrawings,
} from "@/app/lib/ai/chat/transcript";
import { besideQuestion, frozenContext, nowOpen, withoutTail } from "@/app/lib/ai/chat/turnContext";
import type { AbMessage, TurnContext } from "@/app/lib/ai/chat/types";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { streamLedger } from "@/app/lib/ai/streamLedger";
import { asSession } from "@/app/lib/convexServer";
import { quotaResponse } from "@/app/lib/entitlementGate";
import { refuseIfLimited } from "@/app/lib/requestLimitGate";
import { isChatRefusal, isQuotaRefusal } from "@/convex/entitlements";
import { session } from "@/app/lib/session";
import * as Sentry from "@sentry/nextjs";

/**
 * The chat agent's loop.
 *
 * The model runs here, on the server, because the API key must stay here. Tools
 * that touch the document are declared WITHOUT an `execute`, which ends the
 * step and streams the call to the browser — the applier needs the live editor
 * instance, so the document is only ever mutated client-side, through the same
 * path a human edit takes.
 *
 * Five minutes, because one request is a whole run of server steps: a turn that
 * researches the project before handing sections to the writer measured 92s
 * before the first client tool ended it, and at 60 it was cut off mid-read.
 */
export const maxDuration = 300;

export async function POST(req: Request) {
  const startedAt = Date.now();
  const caller = await session();
  if (!caller) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { messages, projectId, pageId, threadId, drawStyle, comments } = (body ?? {}) as {
    messages?: AbMessage[];
    projectId?: Id<"projects">;
    pageId?: Id<"pages">;
    threadId?: Id<"chatThreads">;
    drawStyle?: unknown;
    comments?: unknown;
  };
  if (!Array.isArray(messages)) {
    return new Response("`messages` must be an array", { status: 400 });
  }
  if (!projectId) {
    return new Response("`projectId` is required", { status: 400 });
  }
  // Required, not optional: it is what the conversation is charged against, and
  // a turn the allowance cannot see is a turn that spends the key for free. The
  // composer always has a thread by the time it sends — it queues the first
  // draft until one exists (`ChatPanel`) — so nothing legitimate arrives without.
  if (!threadId) {
    return new Response("`threadId` is required", { status: 400 });
  }
  // The open page's comments, as the browser holding them digested them. Its
  // own words about comments it could already read, so nothing to authorize —
  // only to bound. `toDigest` never builds what this refuses, so a refusal is a
  // client from another build, and costs it the comments rather than the turn.
  const digest = comments === undefined ? undefined : parseDigest(comments);
  if (digest && !digest.ok && process.env.NODE_ENV !== "production") {
    console.warn(`[chat] comments digest ignored: ${digest.reason}`);
  }

  // A turn that has spent its budget gets one last step with no tools, which is
  // what ends it: an answer from what it has, rather than another call it cannot
  // afford. Never on the request carrying an answered approval, though: the
  // nudge goes after the tool message, and the SDK reads approval responses off
  // the last message only, so appending anything discards the user's answer and
  // the call is neither run nor denied. Running it costs no step — it happens
  // before the first one — so the nudge simply lands on the next request.
  const budget = AI.chat.maxSteps - stepsTaken(messages);
  const spent = budget <= 0 && !answeringApproval(messages);

  // Resolved before anything is spent: a lane with no route under this
  // deployment's `USE_OPENROUTER`, or a missing key, used to throw only after
  // the limiter and `beginChat` had charged the conversation, and arrive as a
  // bare 500 (NT-87). Now it costs nothing, is reported, and the panel says the
  // assistant is unavailable rather than showing a stack's worth of nothing.
  let call: ReturnType<typeof chatModel>;
  try {
    call = chatModel();
  } catch (e) {
    console.error("[chat] no model to answer with", e);
    Sentry.captureException(e);
    return Response.json({ code: "model_unavailable" }, { status: 503 });
  }

  // Not `asUser`: this request streams past the life of one token, and the
  // ledger row at the end — and a drawing stored after a slow artist — must
  // still be written as the user. See `asSession`.
  const convex = asSession(caller);

  // What the question was asked beside, when this request resumes a turn that
  // already rendered it: the same bytes go in the same place, and neither the
  // page pack nor the comments gate is asked again (NT-97).
  const frozen = frozenContext(messages);

  // The project's context pack. Read per request rather than per turn because
  // the project is a living thing, and it is one round trip: without it the
  // agent writes into every project as if it were the same project. Started
  // here so it runs beside the limiter below; the paid comments gate waits for
  // it, since it is what says the caller may read this project at all.
  const note = frozen ? "" : openPageNote(pageId);
  const reading = convex
    .query(api.context.read.packInputs, { projectId, ...(note ? { pageId } : {}) })
    .catch(() => null);
  // Only a digest of the page the note names: "this page" has to mean one page.
  const offered = digest?.ok && note && digest.digest.pageId === pageId ? digest.digest : null;

  // A call whose result never arrived — an abandoned turn, a closed tab — is
  // dropped rather than sent. Providers reject an unanswered call, which would
  // otherwise fail every later message in the thread and not just that one.
  //
  // `convertDataPart` is where a mention and an attached text file become
  // something the model reads; without it they are UI and nothing more.
  // Named explicitly: inference reads `Omit<UI_MESSAGE, "id">` and falls back to
  // the base message, which has no data parts for `convertDataPart` to convert.
  //
  // The tools go in too: a tool's `toModelOutput` runs here, on the result the
  // browser answered with, and nowhere else — `look_at`'s pictures otherwise
  // reached the model as a JSON string of base64 (NT-91).
  const tools = chatTools(
    projectId,
    convex,
    caller.userId,
    // The user's style for this turn's drawings, set by the picker that
    // answered the draw approvals. Absent or malformed reads as the
    // default — a request hand-rolled without a choice still draws.
    drawChoiceSchema.safeParse(drawStyle).data,
  );
  const history = stripDrawings(
    shortenStaleReads(
      await convertToModelMessages<AbMessage>(messages, {
        ignoreIncompleteToolCalls: true,
        convertDataPart,
        tools,
      }),
    ),
  );

  // Every request that will reach the model spends one `agentGeneration` — and
  // a turn is several such requests as client tools are answered, which is why
  // the bucket's burst capacity is sized well above one turn's step ceiling: a
  // valid turn, however long, cannot throttle itself. Ahead of `beginChat`, so
  // a throttled turn spends neither the provider key nor the permanent chat
  // allowance, and the `429` stays distinct from that `402`.
  const limited = await refuseIfLimited(convex, "agentGeneration");
  if (limited) return limited;

  // Whether this turn reads the page's comments: a paid call of a second or
  // two that the model's prompt waits on, so it runs beside `beginChat` rather
  // than after it (NT-88). After the limiter, which is what bounds how often it
  // can be asked, and after the context read, so only a caller the project
  // admits is asked about at all. Called off if `beginChat` refuses the turn.
  const refused = new AbortController();
  const wanted = offered
    ? reading.then((inputs) =>
        inputs
          ? commentsWanted(
              convex,
              messages,
              offered,
              budget > 0,
              AbortSignal.any([req.signal, refused.signal]),
              { ownerId: caller.userId, projectId },
            ).catch(() => false)
          : null,
      )
    : null;

  // Charges the conversation against the free allowance, once, and refuses when
  // there is none left. Idempotent, which matters here: one turn is several
  // requests as client tools are answered, and only the first is a new
  // conversation. Ahead of the model, so a refusal costs nothing.
  try {
    await convex.mutation(api.entitlements.beginChat, { threadId, projectId });
  } catch (e) {
    refused.abort();
    if (isQuotaRefusal(e)) return quotaResponse(e.data.meter);
    // Demoted, or the project gone, mid-conversation: theirs to be told,
    // not a server error (NT-83). `retryNotice` words it in the panel.
    if (isChatRefusal(e)) return Response.json(e.data, { status: 403 });
    throw e;
  }

  const inputs = await reading;
  // Not for a caller the project refused, or a turn with no step left to use it in.
  const withComments = wanted ? await wanted : null;
  const pageComments = offered && inputs ? offered : null;
  const about = inputs ? projectPack(inputs, AI.chat.context.projectTokens) : "";

  // Separate instructions, not one concatenated string. The breakpoint goes on
  // the last thing that holds for the whole conversation — the standing prompt
  // and the project's context — so it stands for those and for the tool schemas
  // above them. Nothing that moves with the open page is up here: above the
  // conversation, a change to it was a change to the prefix of all of it.
  const instructions: SystemModelMessage[] = [{ role: "system", content: SYSTEM }];
  if (about) instructions.push({ role: "system", content: about });
  instructions[instructions.length - 1].providerOptions = cached();

  // The page the question was asked from and what surrounds it, rendered on
  // the turn's first request and fixed from then on. A user message, not a
  // system one: it carries page briefs and, when the gate lets them in,
  // collaborators' comments, and whoever may write on a page would otherwise
  // speak to the owner's agent with the app's authority. It is also read back
  // from the browser on the requests that follow.
  const context: TurnContext = frozen ?? {
    ...(note ? { pageId } : {}),
    text: attached([
      note,
      inputs && note ? pagePack(inputs, pageId, AI.chat.context.pageTokens) : "",
      pageComments && withComments
        ? commentsPack(pageComments, AI.chat.context.commentsTokens)
        : "",
    ]),
  };
  const asked = besideQuestion(history, context.text);
  // Last, not beside the question: it changes as the agent moves between
  // pages, and last is the one place a change moves nothing after it.
  const moved = nowOpen(context, pageId);
  const tail: ModelMessage[] = [
    ...(moved ? [moved] : []),
    ...(spent ? [{ role: "user" as const, content: OUT_OF_STEPS }] : []),
  ];

  // Taken apart rather than spread: this call's tool typing is what the step
  // budget is checked against, and spreading a bundle that declares an
  // optional `tools` would widen it.
  const { model, providerOptions } = call;

  // One row per request whichever way it ends — a provider refusal, an error
  // mid-stream, a reply cut off at the cap, a closed tab or the `maxDuration`
  // kill — with the time to the model's first output. `onEnd` alone recorded
  // only the endings that went well, and all of them as `ok` (NT-89).
  const ledger = streamLedger(
    ({ usage, ...outcome }) => {
      if (usage) report(usage);
      recordAiCall(convex, {
        ownerId: caller.userId,
        feature: "chat",
        model: AI.chat.model,
        projectId,
        promptTokens: usage?.inputTokens,
        completionTokens: usage?.outputTokens,
        cacheReadTokens: usage?.inputTokenDetails.cacheReadTokens,
        cacheWriteTokens: usage?.inputTokenDetails.cacheWriteTokens,
        ...outcome,
      });
    },
    { startedAt, signal: req.signal, maxDurationS: maxDuration },
  );

  const result = streamText({
    model,
    providerOptions,
    instructions,
    messages: [...asked, ...tail],
    // Marked per step, not once per request: the server tools run several steps
    // inside one request, and each re-sends everything the last one read. Marked
    // only at the request's start, those reads were paid for in full every step —
    // a research-heavy turn ran at 22% cached. The tail is kept last, and outside
    // the marks, which belong on what the next step will read again.
    prepareStep: ({ messages }) => ({
      messages: [...markCachePoints(foldResearch(withoutTail(messages, tail))), ...tail],
    }),
    tools,
    // The tools that could change something are not merely discouraged, they
    // are refused by the provider. Refused, not removed: the tool schemas head
    // the cached prefix, and a request without them is a miss on the whole
    // conversation — on a turn's longest request (NT-97).
    toolChoice: spent ? "none" : undefined,
    stopWhen: stepCountIs(Math.max(1, budget)),
    experimental_download: downloadAttachments,
    abortSignal: req.signal,
    ...ledger.callbacks,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream<ToolSet, AbMessage>({
      stream: ledger.watch(result.stream),
      // The turn's context rides the answer's metadata, so the requests that
      // resume this turn send it back instead of rendering it again; the gate's
      // answer too, which a turn from before the context was kept still reads.
      messageMetadata: ({ part }) =>
        part.type === "start"
          ? {
              turnContext: context,
              ...(pageComments && withComments !== null
                ? { commentsGate: { pageId: pageComments.pageId, include: withComments } }
                : {}),
            }
          : undefined,
    }),
  });
}

/**
 * Whether this turn reads the page's comments. A turn resumed after a client
 * tool already asked about this page, and its answer is on the message being
 * continued; the request that opens a turn, one that has moved to another
 * page, or one whose answer was lost asks the gate — when `mayAsk`. Null
 * when there was neither an answer nor leave to ask for one.
 */
async function commentsWanted(
  convex: ReturnType<typeof asSession>,
  messages: AbMessage[],
  digest: CommentsDigest,
  mayAsk: boolean,
  signal: AbortSignal,
  asker: { ownerId: string | null; projectId?: string },
): Promise<boolean | null> {
  const last = messages[messages.length - 1];
  const asked = last?.role === "assistant" ? last.metadata?.commentsGate : undefined;
  if (asked?.pageId === digest.pageId && typeof asked.include === "boolean") return asked.include;
  if (!mayAsk) return null;
  const summary = gateSummary(digest, AI.commentsGate);
  return commentsGate(convex, { message: latestUserText(messages), ...summary }, signal, asker);
}

/** The turn's context: what there is of it, under the line that says whose it is. */
function attached(sections: string[]): string {
  const said = sections.filter(Boolean);
  return said.length ? [ATTACHED, ...said].join("\n\n") : "";
}

/** The words of the user's latest message, without its attachments or mentions. */
function latestUserText(messages: AbMessage[]): string {
  const user = messages.findLast((message) => message.role === "user");
  return (user?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * What the request cost, in development only.
 *
 * The one thing about this loop that cannot be read off the code is whether the
 * prefix the breakpoints mark is actually being hit — a cached input token is
 * worth about a tenth of a fresh one, so `cache` against `fresh` is the whole
 * measurement, and a run of `fresh` means something above has stopped matching.
 */
function report(usage: LanguageModelUsage) {
  if (process.env.NODE_ENV === "production") return;
  const { inputTokens, outputTokens, inputTokenDetails: details } = usage;
  const cache = details.cacheReadTokens ?? 0;
  const wrote = details.cacheWriteTokens ?? 0;
  const fresh = details.noCacheTokens ?? (inputTokens ?? 0) - cache - wrote;
  const share = inputTokens ? Math.round((cache / inputTokens) * 100) : 0;
  console.log(
    `[chat] in ${inputTokens ?? "?"} (cache ${cache}, wrote ${wrote}, fresh ${fresh}` +
      `, ${share}% cached) out ${outputTokens ?? "?"}`,
  );
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
