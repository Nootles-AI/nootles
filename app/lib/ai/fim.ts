/**
 * Server-side helpers for Mistral Codestral's fill-in-the-middle endpoint.
 * Shared by the inline-completion route (streaming) and the planner (which uses
 * the non-streaming variant to generate code-block bodies — the LLM+FIM split,
 * where a code model writes the code).
 */

import { AI } from "./aiConfig";

const FIM_URL = "https://api.mistral.ai/v1/fim/completions";
const { maxBefore: MAX_BEFORE, maxAfter: MAX_AFTER } = AI.fim;

/** Where prose ends: a line break the suffix did not ask for. */
const DEFAULT_STOP = ["\n\n", "\n"];

export type FimOpts = {
  maxTokens?: number;
  /**
   * Where the model must stop, or `"none"` for the deliberate absence of any
   * stop sequence.
   *
   * A word rather than `[]`, because an empty array reads as "unset" at the
   * call site: written that way the newline stops were silently off for every
   * editor completion, and nothing in the request said so.
   */
  stop?: string[] | "none";
  signal?: AbortSignal;
  /**
   * Grammar teaching prepended to the prompt, and the one part of it exempt
   * from `MAX_BEFORE`.
   *
   * A seed has to lead to read as a preamble, and the document is trimmed from
   * its head so the caret keeps its neighbourhood — so a seed concatenated into
   * `before` is the first thing trimmed away, silently, on exactly the pages
   * long enough to need trimming. Exempt rather than counted because it is a
   * constant of the lane and the cap is there to bound the page: counted, the
   * two would compete, and the page would lose ground every time the seed grew.
   */
  seed?: string;
  /** Called once when the stream settles, with whatever the ledger can use. */
  onDone?: (result: FimDone) => void;
};

export type FimDone = {
  usage?: { promptTokens?: number; completionTokens?: number };
  status: "ok" | "error" | "aborted";
  errorCode?: string;
  ttfbMs?: number;
  latencyMs: number;
};

async function fimFetch(
  before: string,
  after: string,
  opts: FimOpts,
  stream: boolean,
): Promise<Response> {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error("MISTRAL_API_KEY is not set");
  const trimmed = before.length > MAX_BEFORE ? before.slice(-MAX_BEFORE) : before;
  const prompt = (opts.seed ?? "") + trimmed;
  const suffix = after.length > MAX_AFTER ? after.slice(0, MAX_AFTER) : after;
  const stop = opts.stop ?? DEFAULT_STOP;
  return fetch(FIM_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI.fim.model,
      prompt,
      suffix,
      max_tokens: opts.maxTokens ?? AI.fim.maxTokens.prose,
      temperature: 0.2,
      ...(stop === "none" ? {} : { stop }),
      stream,
    }),
    signal: opts.signal,
  });
}

/** Open a FIM stream and return a Response of plain-text token deltas. */
export async function streamFim(
  before: string,
  after: string,
  opts: FimOpts = {},
): Promise<Response> {
  const started = performance.now();
  let settled = false;
  const settle = (r: Omit<FimDone, "latencyMs">) => {
    if (settled) return;
    settled = true;
    opts.onDone?.({ ...r, latencyMs: Math.round(performance.now() - started) });
  };

  let upstream: Response;
  try {
    upstream = await fimFetch(before, after, opts, true);
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      settle({ status: "aborted" });
      return new Response(null, { status: 204 });
    }
    settle({ status: "error", errorCode: "fetch-failed" });
    return new Response("Upstream request failed", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    settle({ status: "error", errorCode: `upstream-${upstream.status}` });
    return new Response(`Upstream error ${upstream.status}`, { status: 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Mistral reports usage on the final frame; hold whatever arrives.
      let usage: FimDone["usage"];
      let ttfbMs: number | undefined;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              settle({ status: "ok", usage, ttfbMs });
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(data);
              const choice = json.choices?.[0];
              const delta: string = choice?.delta?.content ?? choice?.text ?? "";
              if (json.usage) {
                usage = {
                  promptTokens: json.usage.prompt_tokens,
                  completionTokens: json.usage.completion_tokens,
                };
              }
              if (delta) {
                if (ttfbMs === undefined) {
                  ttfbMs = Math.round(performance.now() - started);
                }
                controller.enqueue(encoder.encode(delta));
              }
            } catch {
              // Ignore a malformed/partial frame; the next read reassembles it.
            }
          }
        }
        settle({ status: "ok", usage, ttfbMs });
        controller.close();
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          settle({ status: "aborted", usage, ttfbMs });
          controller.close();
        } else {
          settle({ status: "error", errorCode: "stream-failed", usage, ttfbMs });
          controller.error(e);
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Non-streaming: return the full completion text (used for code-block bodies). */
export async function generateFim(
  before: string,
  after: string,
  opts: FimOpts = {},
): Promise<string> {
  const upstream = await fimFetch(
    before,
    after,
    { ...opts, maxTokens: opts.maxTokens ?? 256 },
    false,
  );
  if (!upstream.ok) return "";
  const json = await upstream.json();
  const choice = json.choices?.[0];
  return String(choice?.message?.content ?? choice?.text ?? "");
}
