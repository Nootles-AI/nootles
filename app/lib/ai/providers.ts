/**
 * Who gets billed for a model call.
 *
 * One flag, read on the server only. `USE_OPENROUTER=true` sends every lane
 * back through the aggregator on one key; unset or false — the default — calls
 * each vendor directly on its own key, so a lane that runs away can only spend
 * the budget of the one service it belongs to.
 *
 * The ids in `aiConfig` stay OpenRouter slugs under both settings. They are the
 * cost ledger's keys (`AI.prices`), and a row costed today has to still cost the
 * same next year; what a vendor calls the same model is a wire detail, mapped
 * here at the wire and nowhere else.
 *
 * This module deliberately imports nothing. The small lanes reach it for the
 * whole wire — where to POST, what pays, and the body fields that differ by
 * vendor; only the four lanes that go through the `ai` package need a provider
 * adapter, and those live in `chat/provider.ts`.
 */

export type Vendor = "google" | "openai" | "recraft";

/** True only for an explicit opt-in, so a typo fails closed onto direct keys. */
export function viaOpenRouter(): boolean {
  const flag = process.env.USE_OPENROUTER?.trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

/**
 * Slug → the vendor, and the name that vendor's own API answers to.
 *
 * Recraft is the only one that is not the slug with its prefix removed, and the
 * difference matters: `recraftv3` is the RASTER line. Only an id ending
 * `_vector` returns SVG, and this lane reads the response as text — so the
 * plain id would hand `importSvgScene` a PNG and miss every drawing.
 */
const DIRECT: Record<string, { vendor: Vendor; id: string }> = {
  "google/gemini-2.5-flash": { vendor: "google", id: "gemini-2.5-flash" },
  "google/gemini-3.7-flash": { vendor: "google", id: "gemini-3.7-flash" },
  "openai/gpt-5.6-terra": { vendor: "openai", id: "gpt-5.6-terra" },
  "recraft/recraft-v3": { vendor: "recraft", id: "recraftv3_vector" },
};

/** The vendor behind a slug. Throws rather than guess: an unmapped model would
 *  otherwise reach a vendor under a name it does not know, and read as a 404
 *  from the lane rather than as the missing line it is. */
export function directModel(slug: string): { vendor: Vendor; id: string } {
  const hit = DIRECT[slug];
  if (!hit) {
    throw new Error(`No direct route for "${slug}" — add it to DIRECT in providers.ts`);
  }
  return hit;
}

const KEY_NAMES: Record<Vendor | "openrouter", string> = {
  openrouter: "OPENROUTER_API_KEY",
  // The name `@ai-sdk/google` reads by default, so the adapter and the small
  // lanes below take their key from one variable.
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  recraft: "RECRAFT_API_KEY",
};

export function apiKey(vendor: Vendor | "openrouter"): string {
  const name = KEY_NAMES[vendor];
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Endpoints that speak OpenAI's chat-completions shape — request body and
 * response envelope alike. Gemini's is its OpenAI-compatible surface rather
 * than its native one, chosen so the three small lanes keep a single code path
 * instead of branching a body they already build correctly.
 */
const CHAT_URLS: Record<"openrouter" | "google" | "openai", string> = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
};

/** Where a call goes, what pays for it, and the body fields the wire dictates. */
export type Target = {
  url: string;
  key: string;
  /** Spread over the caller's body, and last — the wire wins over the lane. */
  body: Record<string, unknown>;
};

/**
 * Room for a thinking model to think, on top of the answer the lane asked for.
 *
 * Gemini 3 spends its reasoning INSIDE `max_tokens`, so a ceiling written for
 * the answer alone is really a thinking budget that leaves nothing over. It
 * fails as silence rather than as an error: `finish_reason` comes back "length"
 * with a truncated fragment, which parses to no candidates and reads exactly
 * like a model that had nothing to suggest.
 *
 * Measured on this lane's own prompt at 900: an eleven-block run spent 860
 * tokens thinking and got 30 out, three times in a row. Headroom rather than a
 * bigger ceiling because the two numbers mean different things — the lane still
 * says how long an ANSWER may be, and this says the reasoning is not part of it.
 * Unused headroom is free; thinking tokens are billed only once generated.
 */
const THINKING_HEADROOM = 2048;

/**
 * Why an upstream call failed, in development only.
 *
 * The small lanes answer a refusal with an empty result — right for a
 * suggestion nobody asked for, and wrong for working out why it is ALWAYS
 * empty: a rejected key and an unknown model id both arrive as "no
 * candidates". The vendor's own message is the only thing that tells them
 * apart, so it is read here rather than thrown away, and the body is cloned so
 * the caller's own read is untouched.
 */
export async function reportUpstream(lane: string, res: Response): Promise<void> {
  if (process.env.NODE_ENV === "production") return;
  const detail = await res
    .clone()
    .text()
    .catch(() => "");
  console.warn(
    `[${lane}] upstream ${res.status} ${res.statusText} — ${detail.slice(0, 500) || "(no body)"}`,
  );
}

/**
 * For the small one-shot lanes: reformat, categorize, feedback completion.
 *
 * `answerTokens` is how long the ANSWER may be. What that costs on the wire is
 * this function's business — a thinking model needs the headroom above, and its
 * reasoning is pinned low in whichever dialect the route speaks. Low rather than
 * off because 3.7 Flash cannot be told to stop thinking, only to think less; and
 * pinned at all because the default is medium, which on this prompt was 2.5x the
 * latency for the same three chips. These lanes answer a pause in typing.
 */
export function chatTarget(slug: string, answerTokens: number): Target {
  // Read even on the aggregator's path, where only the vendor is wanted: DIRECT
  // is the one list of models this app can call, and a slug missing from it is a
  // missing line either way.
  const { vendor, id } = directModel(slug);
  if (vendor === "recraft") {
    throw new Error(`"${slug}" is an image model, not a chat model`);
  }
  const thinks = vendor === "google";
  const max_tokens = answerTokens + (thinks ? THINKING_HEADROOM : 0);

  if (viaOpenRouter()) {
    return {
      url: CHAT_URLS.openrouter,
      key: apiKey("openrouter"),
      body: { model: slug, max_tokens, ...(thinks ? { reasoning: { effort: "low" } } : {}) },
    };
  }
  return {
    url: CHAT_URLS[vendor],
    key: apiKey(vendor),
    body: { model: id, max_tokens, ...(thinks ? { reasoning_effort: "low" } : {}) },
  };
}

/**
 * Statuses worth asking again about: the vendor is busy or briefly broken, and
 * the same request a moment later usually lands. A rejected key or an unknown
 * model will answer the same way forever, and retrying those only spends twice.
 */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/** Long enough to be a different moment, short enough to sit inside an ambient
 *  lane's own debounce. */
const RETRY_PAUSE_MS = 250;

/**
 * POST a chat body, once more if the vendor was merely busy.
 *
 * The aggregator used to absorb this class of failure by re-routing to another
 * provider, and calling vendors directly gave that up without replacing it —
 * measured at roughly one refusal in fifteen, each of which is a suggestion the
 * user never sees. One retry, because a lane that fires on every pause must not
 * turn a bad minute at the vendor into a burst of its own.
 */
export async function postChat(
  target: Target,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, ...target.body }),
      signal,
    });
    if (res.ok || attempt > 0 || !TRANSIENT.has(res.status)) return res;
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    signal?.throwIfAborted();
  }
}

/**
 * Prompt and completion counts, with thinking folded into the completion.
 *
 * Gemini reports its reasoning in neither field — it shows up only as the gap in
 * `total_tokens` — but bills it as output. Leaving it out under-charged every
 * row in the ledger by the larger half of the call.
 */
export function readUsage(
  usage: unknown,
): { promptTokens?: number; completionTokens?: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens);
  const thought = total !== undefined ? total - (prompt ?? 0) - (completion ?? 0) : 0;
  return {
    ...(prompt !== undefined ? { promptTokens: prompt } : {}),
    ...(completion !== undefined
      ? { completionTokens: completion + Math.max(0, thought) }
      : {}),
  };
}

/** The image lane's wire. Not a `Target`: it builds its own body from the frame
 *  and the style card, and has no token ceiling to reconcile. */
export type ImageTarget = { url: string; key: string; model: string };

/** The image lane. Recraft is the only vendor here, and its own API takes the
 *  same OpenAI-shaped envelope OpenRouter wraps. */
export function imageTarget(slug: string): ImageTarget {
  if (viaOpenRouter()) {
    return {
      url: "https://openrouter.ai/api/v1/images/generations",
      key: apiKey("openrouter"),
      model: slug,
    };
  }
  const { vendor, id } = directModel(slug);
  if (vendor !== "recraft") {
    throw new Error(`"${slug}" is not an image model`);
  }
  return {
    url: "https://external.api.recraft.ai/v1/images/generations",
    key: apiKey("recraft"),
    model: id,
  };
}
