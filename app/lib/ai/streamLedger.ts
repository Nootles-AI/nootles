import { APICallError, RetryError, StreamProviderError, type LanguageModelUsage } from "ai";

/**
 * One ledger row for one `streamText` call, whichever way it ends.
 *
 * `onEnd` alone, which is what chat and diagrams used to record from, is
 * called for one ending out of five (measured on `ai@7.0.114`, NT-89):
 *
 * - finished, including cut off at the token cap: `onEnd`, with the reason;
 * - a provider error mid-stream: `onError`, then `onEnd` with `"error"`;
 * - refused before the first byte (a 429, a 500, a context overflow):
 *   `onError`, and the stream closes with no `onEnd`;
 * - the response body failing under it: neither — the stream just errors;
 * - the caller aborting: `onAbort`, never `onEnd`.
 *
 * So the ledger ended up with no row for failures, `ok` for the rest, and no
 * `aborted` row at all, although the route had a status for one. This listens
 * on every callback and on the stream itself, and settles the row once, at the
 * first ending it sees. Tokens come from `onEnd` when it runs, else from the
 * steps that finished: a step that was cut off never reported its usage to
 * anyone.
 *
 * A function killed at `maxDuration` runs no callback at all, so a deadline
 * settles the row as `timeout` just before the platform's: close enough to
 * the kill that a call finishing in the gap is rare, and far enough ahead for
 * the row to reach Convex.
 */

export type StreamOutcome = {
  status: "ok" | "error" | "aborted" | "timeout";
  errorCode?: string;
  usage?: LanguageModelUsage;
  latencyMs: number;
  /** From the same start as `latencyMs` to the model's first output. */
  ttfbMs?: number;
};

/** How long before the platform's own kill the deadline records a `timeout`. */
export const DEADLINE_MARGIN_MS = 3_000;

/** What counts as the model's first output: the user sees something move. */
const OUTPUT = new Set(["text-delta", "reasoning-delta", "tool-input-start"]);

export function streamLedger(
  record: (outcome: StreamOutcome) => void,
  {
    startedAt,
    signal,
    maxDurationS,
  }: {
    /** What `latencyMs` and `ttfbMs` count from — the request's arrival. */
    startedAt: number;
    /** The request's own signal, which is what an `aborted` row means. */
    signal?: AbortSignal;
    /** The route's `maxDuration`, for the `timeout` row. */
    maxDurationS?: number;
  },
) {
  let settled = false;
  let ttfbMs: number | undefined;
  let failure: unknown;
  let steps: LanguageModelUsage | undefined;

  const deadline =
    maxDurationS === undefined
      ? undefined
      : setTimeout(
          () => settle({ status: "timeout", errorCode: "max-duration" }),
          Math.max(0, maxDurationS * 1000 - DEADLINE_MARGIN_MS - (Date.now() - startedAt)),
        );
  // Never what keeps a process alive: a test, or a dev server shutting down.
  (deadline as { unref?: () => void } | undefined)?.unref?.();

  function settle(outcome: Omit<StreamOutcome, "latencyMs" | "ttfbMs" | "usage">, usage = steps) {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    record({
      ...outcome,
      ...(usage ? { usage } : {}),
      latencyMs: Date.now() - startedAt,
      ...(ttfbMs !== undefined ? { ttfbMs } : {}),
    });
  }

  /** The error's row, or `aborted` when the error is the request going away. */
  function failed(error: unknown) {
    if (signal?.aborted || isAbort(error)) settle({ status: "aborted" });
    else settle({ status: "error", errorCode: errorCode(error) });
  }

  return {
    /** Settles the row for a call that threw before it could stream. */
    fail: failed,

    /** For `streamText`. */
    callbacks: {
      onChunk: ({ chunk }: { chunk: { type: string } }) => {
        if (ttfbMs === undefined && OUTPUT.has(chunk.type)) ttfbMs = Date.now() - startedAt;
      },
      onStepEnd: ({ usage }: { usage: LanguageModelUsage }) => {
        steps = steps ? addUsage(steps, usage) : usage;
      },
      onError: ({ error }: { error: unknown }) => {
        // Not settled here: an error inside a step is followed by `onEnd`,
        // which carries the tokens the failed call still spent.
        failure ??= error;
        const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
        console.error(`[ai] stream error (${errorCode(error)}): ${message.split("\n")[0].slice(0, 300)}`);
      },
      onEnd: ({ finishReason, totalUsage }: { finishReason: string; totalUsage: LanguageModelUsage }) => {
        if (signal?.aborted) settle({ status: "aborted" }, totalUsage);
        else if (failure !== undefined || finishReason === "error")
          settle({ status: "error", errorCode: errorCode(failure) }, totalUsage);
        // Cut off at the cap: what arrived is the head of an answer — the
        // same code the reformat lane records for it.
        else if (finishReason === "length") settle({ status: "error", errorCode: "truncated" }, totalUsage);
        else if (finishReason === "content-filter")
          settle({ status: "error", errorCode: "content-filter" }, totalUsage);
        else settle({ status: "ok" }, totalUsage);
      },
      onAbort: () => settle({ status: "aborted" }),
    },

    /**
     * `stream`, passed through unchanged, settling the row when it ends without
     * a callback having done so: closed after an `onError` with no `onEnd`,
     * failed under the reader, or cancelled by the response going away.
     */
    watch<T>(stream: ReadableStream<T>): ReadableStream<T> {
      const reader = stream.getReader();
      return new ReadableStream<T>({
        async pull(controller) {
          let next: ReadableStreamReadResult<T>;
          try {
            next = await reader.read();
          } catch (error) {
            failed(error);
            controller.error(error);
            return;
          }
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          // `onEnd` runs before the stream it belongs to closes, so a row
          // still open here had none.
          if (failure !== undefined) failed(failure);
          else if (signal?.aborted) settle({ status: "aborted" });
          else settle({ status: "error", errorCode: "no-finish" });
          controller.close();
        },
        async cancel(reason) {
          settle({ status: "aborted" });
          await reader.cancel(reason);
        },
      });
    },
  };
}

export type StreamLedger = ReturnType<typeof streamLedger>;

/**
 * A short, stable code for what went wrong, in the terms the FIM lane already
 * records: `upstream-<status>` for an answer the vendor refused — before the
 * stream as an `APICallError`, or inside it as a `StreamProviderError`, whose
 * status may only be the vendor's own code — `fetch-failed` for one that never
 * came, else the error's own name.
 */
export function errorCode(error: unknown): string {
  if (error === undefined) return "stream-error";
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause) && cause.statusCode === undefined) return "fetch-failed";
  const { statusCode, code } = (cause ?? {}) as { statusCode?: unknown; code?: unknown };
  if (typeof statusCode === "number") return `upstream-${statusCode}`;
  if (StreamProviderError.isInstance(cause) && (typeof code === "string" || typeof code === "number")) {
    return `upstream-${String(code).replace(/[^\w-]/g, "")}`.slice(0, 64);
  }
  const name = cause instanceof Error ? cause.name : "";
  return (name.replace(/^AI_/, "").replace(/[^\w-]/g, "") || "stream-error").slice(0, 64);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));

function addUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
  return {
    ...a,
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    inputTokenDetails: {
      ...a.inputTokenDetails,
      noCacheTokens: sum(a.inputTokenDetails.noCacheTokens, b.inputTokenDetails.noCacheTokens),
      cacheReadTokens: sum(a.inputTokenDetails.cacheReadTokens, b.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: sum(a.inputTokenDetails.cacheWriteTokens, b.inputTokenDetails.cacheWriteTokens),
    },
    outputTokenDetails: {
      ...a.outputTokenDetails,
      textTokens: sum(a.outputTokenDetails.textTokens, b.outputTokenDetails.textTokens),
      reasoningTokens: sum(a.outputTokenDetails.reasoningTokens, b.outputTokenDetails.reasoningTokens),
    },
  };
}
