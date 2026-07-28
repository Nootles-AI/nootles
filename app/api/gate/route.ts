import { AI } from "@/app/lib/ai/aiConfig";

/**
 * Tier 1 of the suggestion pipeline: a binary confirm.
 *
 * A local heuristic has already proposed something; this only decides whether
 * it is worth interrupting the writer. Framing it as YES/NO (rather than asking
 * a model to classify from scratch) matters a lot — measured, 5-way
 * classification on small models is action-biased and fires on ordinary prose,
 * whereas this framing scored 6/6 on the same cases at ~0.25s.
 *
 * Runs on a Groq-hosted 8B pinned through OpenRouter. Plain fetch, no SDK: this
 * is the hot path and every millisecond is visible. Anything slow or broken
 * degrades to NO — a missed suggestion is invisible, a late one is not.
 */

const URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM = [
  "You gate an inline suggestion in a document editor. A heuristic proposed a",
  "suggestion; decide if it is genuinely worth interrupting the writer.",
  "Answer exactly YES or NO. Default to NO. Answer YES only if the proposal is",
  "obviously right and useful. Ordinary prose being written normally is always NO.",
].join(" ");

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false });
  }
  const { proposal, nearbyText } = (body ?? {}) as {
    proposal?: unknown;
    nearbyText?: unknown;
  };
  if (typeof proposal !== "string" || typeof nearbyText !== "string") {
    return Response.json({ ok: false });
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return Response.json({ ok: false });

  // Give up fast, and bail if the client aborted (superseded pause).
  const signal = AbortSignal.any([
    req.signal,
    AbortSignal.timeout(AI.gate.timeoutMs),
  ]);

  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI.gate.model,
        provider: AI.gate.provider,
        max_tokens: 2,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `Proposal: ${proposal}.\nText near cursor: ${JSON.stringify(
              nearbyText.slice(0, 600),
            )}`,
          },
        ],
      }),
      signal,
    });
    if (!res.ok) return Response.json({ ok: false });
    const json = await res.json();
    const answer = String(json.choices?.[0]?.message?.content ?? "").trim();
    return Response.json({ ok: /^y/i.test(answer) });
  } catch {
    // Timeout, abort, or network error — all mean "don't suggest".
    return Response.json({ ok: false });
  }
}
