import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  StreamProviderError,
  createTextStreamResponse,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DEADLINE_MARGIN_MS, errorCode, streamLedger, type StreamOutcome } from "./streamLedger";

/**
 * Every way a `streamText` call can end, against the real SDK with a mock
 * model, read the way the routes read it: through a text response (diagram)
 * and a UI-message response (chat). One row each, and the right one.
 */

const usage = {
  inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};
const finish = (reason: string): LanguageModelV4StreamPart => ({
  type: "finish",
  finishReason: { unified: reason as "stop", raw: reason },
  usage,
});
const opening: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: "Hello" },
];
const refused = (statusCode?: number) =>
  new APICallError({ message: "refused", url: "https://vendor", requestBodyValues: {}, statusCode });

type Ending =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "refused"
  | "unreachable"
  | "error-part"
  | "body-fails"
  | "hangs";

function model(ending: Ending) {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      if (ending === "refused") throw refused(429);
      if (ending === "unreachable") throw refused(undefined);
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            await new Promise((r) => setTimeout(r, 5));
            for (const part of opening) controller.enqueue(part);
            if (ending === "body-fails") return controller.error(new TypeError("terminated"));
            if (ending === "error-part") {
              controller.enqueue({ type: "error", error: refused(500) });
              controller.enqueue({ type: "text-end", id: "0" });
              controller.enqueue(finish("error"));
              return controller.close();
            }
            if (ending === "hangs") {
              // Until the caller goes away, as a slow vendor would — and then
              // the body fails the way fetch fails it.
              await new Promise((r) => abortSignal?.addEventListener("abort", r));
              return controller.error(new DOMException("This operation was aborted", "AbortError"));
            }
            controller.enqueue({ type: "text-end", id: "0" });
            controller.enqueue(finish(ending));
            controller.close();
          },
        }),
      };
    },
  });
}

/** Streams `ending` through a route-shaped response; returns the one row. */
async function run(
  ending: Ending,
  sink: "text" | "ui",
  { abortAfterMs, cancel, maxRetries = 0 }: { abortAfterMs?: number; cancel?: boolean; maxRetries?: number } = {},
) {
  const rows: StreamOutcome[] = [];
  const request = new AbortController();
  const ledger = streamLedger((row) => rows.push(row), {
    startedAt: Date.now(),
    signal: request.signal,
  });
  const result = streamText({
    model: model(ending),
    prompt: "hi",
    maxRetries,
    abortSignal: request.signal,
    ...ledger.callbacks,
    onError: (event) => {
      // Quiet in the test output; the ledger's own handler still runs.
      vi.spyOn(console, "error").mockImplementationOnce(() => {});
      ledger.callbacks.onError(event);
    },
  });
  const res =
    sink === "text"
      ? createTextStreamResponse({ stream: ledger.watch(result.textStream) })
      : createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: ledger.watch(result.stream) }) });
  if (abortAfterMs !== undefined) setTimeout(() => request.abort(), abortAfterMs);
  if (cancel) {
    const reader = res.body!.getReader();
    await reader.read();
    // The browser going away: the response body is cancelled under the route.
    request.abort();
    await reader.cancel();
  } else {
    await res.text().catch(() => undefined);
  }
  await new Promise((r) => setTimeout(r, 20));
  return rows;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(["text", "ui"] as const)("through a %s response", (sink) => {
  test("a finished call is one ok row, with its tokens and first-output time", async () => {
    const rows = await run("stop", sink);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ok" });
    expect(rows[0].errorCode).toBeUndefined();
    expect(rows[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 7 });
    expect(rows[0].usage?.inputTokenDetails.cacheReadTokens).toBe(40);
    expect(rows[0].ttfbMs).toBeTypeOf("number");
    expect(rows[0].ttfbMs!).toBeLessThanOrEqual(rows[0].latencyMs);
  });

  test("a request that ends on a tool call is ok", async () => {
    expect(await run("tool-calls", sink)).toMatchObject([{ status: "ok" }]);
  });

  test("a reply cut off at the token cap is truncated, with its tokens", async () => {
    const rows = await run("length", sink);
    expect(rows).toMatchObject([{ status: "error", errorCode: "truncated", usage: { outputTokens: 7 } }]);
  });

  test("a filtered reply says so", async () => {
    expect(await run("content-filter", sink)).toMatchObject([{ status: "error", errorCode: "content-filter" }]);
  });

  test("a vendor refusing the call — no onEnd at all — is an error row with its status", async () => {
    const rows = await run("refused", sink);
    expect(rows).toMatchObject([{ status: "error", errorCode: "upstream-429" }]);
    expect(rows[0].ttfbMs).toBeUndefined();
  });

  test("the SDK's own retries still give the vendor's status, not RetryError", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    expect(await run("refused", sink, { maxRetries: 1 })).toMatchObject([
      { status: "error", errorCode: "upstream-429" },
    ]);
  });

  test("a vendor that never answered is fetch-failed", async () => {
    expect(await run("unreachable", sink)).toMatchObject([{ status: "error", errorCode: "fetch-failed" }]);
  });

  test("an error mid-stream is an error row, not ok, and keeps the tokens spent", async () => {
    const rows = await run("error-part", sink);
    expect(rows).toMatchObject([{ status: "error", errorCode: "upstream-500", usage: { outputTokens: 7 } }]);
    expect(rows[0].ttfbMs).toBeTypeOf("number");
  });

  test("a body that fails under the reader — no callback at all — is still a row", async () => {
    expect(await run("body-fails", sink)).toMatchObject([{ status: "error", errorCode: "TypeError" }]);
  });

  test("the request aborted mid-answer — onAbort, never onEnd — is an aborted row", async () => {
    const rows = await run("hangs", sink, { abortAfterMs: 30 });
    expect(rows).toMatchObject([{ status: "aborted" }]);
    expect(rows[0].errorCode).toBeUndefined();
    expect(rows[0].ttfbMs).toBeTypeOf("number");
  });

  test("the response cancelled by the browser is an aborted row", async () => {
    expect(await run("hangs", sink, { cancel: true })).toMatchObject([{ status: "aborted" }]);
  });
});

describe("the deadline", () => {
  test("a call still open just before maxDuration is recorded as a timeout, once", () => {
    vi.useFakeTimers();
    const rows: StreamOutcome[] = [];
    const ledger = streamLedger((row) => rows.push(row), { startedAt: Date.now(), maxDurationS: 60 });
    ledger.callbacks.onStepEnd({ usage: { inputTokens: 5, outputTokens: 2 } as never });
    vi.advanceTimersByTime(60_000 - DEADLINE_MARGIN_MS - 1);
    expect(rows).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(rows).toMatchObject([{ status: "timeout", errorCode: "max-duration", usage: { inputTokens: 5 } }]);
    // The platform's kill never lets it finish, but if it did: no second row.
    ledger.callbacks.onEnd({ finishReason: "stop", totalUsage: {} as never });
    expect(rows).toHaveLength(1);
  });

  test("counts from the request's arrival, not from when the ledger was made", () => {
    vi.useFakeTimers();
    const rows: StreamOutcome[] = [];
    streamLedger((row) => rows.push(row), { startedAt: Date.now() - 20_000, maxDurationS: 60 });
    vi.advanceTimersByTime(40_000 - DEADLINE_MARGIN_MS);
    expect(rows).toMatchObject([{ status: "timeout" }]);
  });

  test("a call that settles first cancels it", () => {
    vi.useFakeTimers();
    const rows: StreamOutcome[] = [];
    const ledger = streamLedger((row) => rows.push(row), { startedAt: Date.now(), maxDurationS: 60 });
    ledger.callbacks.onEnd({ finishReason: "stop", totalUsage: {} as never });
    vi.advanceTimersByTime(120_000);
    expect(rows).toMatchObject([{ status: "ok" }]);
  });

  test("a call that threw before streaming settles it too", () => {
    vi.useFakeTimers();
    const rows: StreamOutcome[] = [];
    const ledger = streamLedger((row) => rows.push(row), { startedAt: Date.now(), maxDurationS: 60 });
    ledger.fail(new Error("no key"));
    vi.advanceTimersByTime(120_000);
    expect(rows).toMatchObject([{ status: "error", errorCode: "Error" }]);
  });
});

describe("errorCode", () => {
  test("names what went wrong in the FIM lane's terms", () => {
    expect(errorCode(refused(503))).toBe("upstream-503");
    expect(errorCode(refused(undefined))).toBe("fetch-failed");
    expect(errorCode(new TypeError("x"))).toBe("TypeError");
    expect(errorCode(Object.assign(new Error("x"), { name: "AI_NoOutputGeneratedError" }))).toBe(
      "NoOutputGeneratedError",
    );
    // A vendor's error inside the stream, as the SDK hands it to onError.
    expect(errorCode(new StreamProviderError({ message: "overloaded", statusCode: 529 }))).toBe("upstream-529");
    expect(errorCode(new StreamProviderError({ message: "oops", code: "server_error" }))).toBe("upstream-server_error");
    expect(errorCode(new StreamProviderError({ message: "oops" }))).toBe("StreamProviderError");
    expect(errorCode("a string")).toBe("stream-error");
    expect(errorCode(undefined)).toBe("stream-error");
  });
});
