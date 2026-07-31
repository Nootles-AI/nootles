/**
 * Server-side helpers for Mistral Codestral's fill-in-the-middle endpoint.
 * Shared by the inline-completion route (streaming) and the planner (which uses
 * the non-streaming variant to generate code-block bodies — the LLM+FIM split,
 * where a code model writes the code).
 */

import { AI } from "./aiConfig";

const FIM_URL = "https://api.mistral.ai/v1/fim/completions";
const MAX_BEFORE = 4000;
const MAX_AFTER = 1000;

export type FimOpts = {
  maxTokens?: number;
  stop?: string[];
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
      max_tokens: opts.maxTokens ?? AI.fim.ghostMaxTokens,
      temperature: 0.2,
      stop: opts.stop ?? ["\n\n", "\n"],
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
  let upstream: Response;
  try {
    upstream = await fimFetch(before, after, opts, true);
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    return new Response("Upstream request failed", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(`Upstream error ${upstream.status}`, { status: 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
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
              controller.close();
              return;
            }
            try {
              const json = JSON.parse(data);
              const choice = json.choices?.[0];
              const delta: string = choice?.delta?.content ?? choice?.text ?? "";
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch {
              // Ignore a malformed/partial frame; the next read reassembles it.
            }
          }
        }
        controller.close();
      } catch (e) {
        if ((e as Error).name === "AbortError") controller.close();
        else controller.error(e);
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
