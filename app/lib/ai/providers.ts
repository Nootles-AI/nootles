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
 * This module deliberately imports nothing. The small lanes reach it for a URL
 * and a key and keep their own `fetch`; only the four lanes that go through the
 * `ai` package need a provider adapter, and those live in `chat/provider.ts`.
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

/** Where a call goes, what pays for it, and what to call the model there. */
export type Target = { url: string; key: string; model: string };

/** For the small one-shot lanes that POST their own body: reformat, categorize,
 *  feedback completion. */
export function chatTarget(slug: string): Target {
  if (viaOpenRouter()) {
    return { url: CHAT_URLS.openrouter, key: apiKey("openrouter"), model: slug };
  }
  const { vendor, id } = directModel(slug);
  if (vendor === "recraft") {
    throw new Error(`"${slug}" is an image model, not a chat model`);
  }
  return { url: CHAT_URLS[vendor], key: apiKey(vendor), model: id };
}

/** The image lane. Recraft is the only vendor here, and its own API takes the
 *  same OpenAI-shaped envelope OpenRouter wraps. */
export function imageTarget(slug: string): Target {
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
