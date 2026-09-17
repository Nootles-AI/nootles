import type {
  LanguageModelV4,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { StagedCall, StageContext, StagedStep } from "./types";

/**
 * A script, wearing a model's clothes.
 *
 * `streamText` cannot tell this from OpenAI, which is the entire design: hand
 * it one of these and the tool loop, the step budget, tool-input validation,
 * the client-tool round trip, persistence and review all run exactly as they
 * do on a real turn. We lie to the loop from outside; the loop stays honest.
 */

const NOTHING: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A finish reason is a pair — the unified one and whatever the provider called
 * it. Ours calls it what it is, which is what shows up in a trace.
 */
const ENDED: LanguageModelV4FinishReason = { unified: "stop", raw: "staged-stop" };
const HANDED_OVER: LanguageModelV4FinishReason = {
  unified: "tool-calls",
  raw: "staged-tool-calls",
};

/** A word and the space in front of it, which is roughly what a token is. */
function wordish(rest: string): number {
  const found = /^\s*\S+/.exec(rest);
  return found ? found[0].length : 1;
}

/**
 * The resolved shape of one request's step: inputs already computed against
 * the live context, so `doStream` is pure timing and has nothing left to
 * decide.
 */
export type ResolvedStep = {
  say?: string;
  calls: { toolName: string; input: unknown }[];
  delayMs: number;
  /** No step left: the script is over and this request only finishes. */
  done: boolean;
};

/**
 * Compute a step's tool inputs against the live document.
 *
 * A resolver returning null is not an error — it is a script saying the thing
 * it meant to act on is not on the page. The whole step collapses to the
 * script's `bail` prose, which is how skipping a beat degrades into an
 * ordinary answer instead of a broken tool call.
 */
export function resolveStep(
  step: StagedStep | undefined,
  ctx: StageContext,
  bail: string | undefined,
): ResolvedStep {
  if (!step) return { calls: [], delayMs: 0, done: true };

  const calls: ResolvedStep["calls"] = [];
  for (const call of step.call ?? []) {
    const input =
      typeof call.input === "function"
        ? (call.input as (c: StageContext) => unknown)(ctx)
        : call.input;
    if ((input === null || input === undefined) && call.optional) continue;
    if (input === null || input === undefined) {
      return {
        say: bail ?? "I can't find that on this page — open the page it's on and ask me again.",
        calls: [],
        delayMs: step.delayMs ?? 400,
        done: false,
      };
    }
    calls.push({ toolName: (call as StagedCall).tool, input });
  }

  // A step whose every call stood down, and which has nothing to say, would end
  // the turn silently — the chips stop, no text arrives, and whatever the script
  // meant to do afterwards never happens. Say the bail instead: a turn that
  // explains itself is recoverable, a turn that vanishes is not.
  if (!calls.length && !step.say) {
    return {
      say: bail ?? "I couldn't find what I needed on this page.",
      calls: [],
      delayMs: step.delayMs ?? 400,
      done: false,
    };
  }

  return { say: step.say, calls, delayMs: step.delayMs ?? 500, done: false };
}

export function stagedModel(id: string, step: ResolvedStep): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "nootles-staged",
    // Carried into `recordAiCall`, so the ledger shows a demo turn as a demo
    // turn rather than as unexplained free traffic.
    modelId: `staged/${id}`,
    supportedUrls: {},
    doGenerate() {
      throw new Error("The staged model streams only.");
    },
    async doStream() {
      return { stream: play(id, step) };
    },
  };
}

/**
 * The step, paced.
 *
 * The jitter is not decoration. A perfectly even reveal reads as a progress
 * bar and instant output reads as fake; it is the unevenness that makes this
 * look like something being written. Same reasoning, and roughly the same
 * numbers, as `tourDrive.reveal`.
 */
function play(id: string, step: ResolvedStep): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      const push = (part: LanguageModelV4StreamPart) => controller.enqueue(part);

      push({ type: "stream-start", warnings: [] });
      push({
        type: "response-metadata",
        id: `staged-${id}-${Date.now()}`,
        modelId: `staged/${id}`,
        timestamp: new Date(),
      });

      // Out of steps: the turn is over and this request exists only to end it.
      if (step.done) {
        push({ type: "finish", finishReason: ENDED, usage: NOTHING });
        controller.close();
        return;
      }

      await sleep(step.delayMs);

      if (step.say) {
        const textId = "0";
        push({ type: "text-start", id: textId });
        let at = 0;
        while (at < step.say.length) {
          const next = Math.min(step.say.length, at + wordish(step.say.slice(at)));
          push({ type: "text-delta", id: textId, delta: step.say.slice(at, next) });
          at = next;
          await sleep(28 * (0.6 + Math.random() * 0.9));
        }
        push({ type: "text-end", id: textId });
      }

      for (const [i, call] of step.calls.entries()) {
        const toolCallId = `stg_${id.replace(/\W/g, "")}_${i}_${Math.random().toString(36).slice(2, 10)}`;
        const input = JSON.stringify(call.input);
        // The chip builds up the way a real one does — start, arguments, end —
        // rather than appearing whole. Costs four parts and buys the pause the
        // room reads as work.
        push({ type: "tool-input-start", id: toolCallId, toolName: call.toolName });
        await sleep(120);
        push({ type: "tool-input-delta", id: toolCallId, delta: input });
        push({ type: "tool-input-end", id: toolCallId });
        push({ type: "tool-call", toolCallId, toolName: call.toolName, input });
        await sleep(90);
      }

      push({
        type: "finish",
        finishReason: step.calls.length ? HANDED_OVER : ENDED,
        usage: NOTHING,
      });
      controller.close();
    },
  });
}
