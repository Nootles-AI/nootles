import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { JSONValue } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel, ToolSet } from "ai";
import { AI } from "../aiConfig";
import { apiKey, directModel, viaOpenRouter } from "../providers";

/**
 * The four lanes that run through the `ai` package, built per request.
 *
 * Server-only: these read the provider keys, which must never reach the
 * browser. That is the whole reason the agent loop streams from a route rather
 * than running the provider client-side, even though the tools that edit the
 * document execute in the browser.
 *
 * Each returns a bundle meant to be spread into `streamText`/`generateText`,
 * not a bare model. Through OpenRouter the dials ride the model's own settings;
 * called directly they are per-request `providerOptions`, and the web search is
 * a tool rather than a plugin. Spreading keeps that difference in this file
 * instead of at four call sites.
 */
export type ModelCall = {
  model: LanguageModel;
  providerOptions?: ProviderOptions;
  tools?: ToolSet;
};

/** The chat agent: a tool loop, so it wants reasoning over latency. */
export function chatModel(): ModelCall {
  if (viaOpenRouter()) {
    return {
      model: openrouter().chat(AI.chat.model, {
        // Usage accounting on, because the cached share of the prompt is the
        // only way to tell a cache breakpoint that is working from one that is
        // being ignored, and OpenRouter leaves those counts out unless asked.
        usage: { include: true },
        // One host while it answers: each keeps its own prompt cache, and a
        // turn that wanders between them pays full price on the one it lands
        // on cold. See `AI.chat.hosts`.
        provider: { order: [...AI.chat.hosts], allow_fallbacks: true },
        // Never left to the provider's default: unset, this model reasons at
        // full effort and spends minutes before the first token.
        reasoning: { effort: AI.chat.effort },
      }),
    };
  }
  const call = direct(AI.chat.model, AI.chat.effort);
  const { vendor } = directModel(AI.chat.model);
  if (vendor === "anthropic") {
    return withOptions(call, "anthropic", {
      thinking: {
        type: "adaptive",
        // The short notes between tool calls arrive as thinking on this
        // line, and are empty unless asked for — the panel would sit
        // silent through a long turn.
        display: "updates",
        // The route edits history the model has already seen — stale reads
        // shortened, drawings stripped, the open-page note moving — and a
        // thinking block replayed after an edit is a 400 on newer accounts.
        // Dropping the block keeps the turn; only that step's reasoning goes.
        blockBinding: { prefixMismatchBehavior: "drop_block" },
      },
      // A classifier refusal re-runs on the model the API picks rather than
      // ending the turn with nothing said.
      fallbacks: "default",
    });
  }
  if (vendor === "openai") {
    return withOptions(call, "openai", {
      // The panel's thinking notes, which OpenAI's API leaves out unless a
      // summary is asked for — the same silence `display` answers above.
      reasoningSummary: "auto",
      // Nothing kept at OpenAI; the reasoning rides the thread instead, as
      // encrypted content on each reasoning part. Stored, a replayed turn
      // names its reasoning by id, and ids expire: a thread reopened a month
      // later would be a 400 on every message after it (NT-87).
      store: false,
    });
  }
  return call;
}

/**
 * The model behind `search_web`, which reads result pages rather than reasons.
 *
 * The search itself is the provider's, and the two providers expose it
 * differently: OpenRouter as a request plugin, Google as a provider-executed
 * tool that must be named `google_search`. Either way the result comes back as
 * text plus sources, which is all the caller reads.
 */
export function searchModel(maxResults: number): ModelCall {
  if (viaOpenRouter()) {
    return {
      model: openrouter().chat(AI.chat.search.model),
      providerOptions: { openrouter: { plugins: [{ id: "web", max_results: maxResults }] } },
    };
  }
  const { vendor, id } = directModel(AI.chat.search.model);
  // The grounding tool is Google's own, so this lane has no other direct form.
  if (vendor !== "google") {
    throw new Error(`search_web runs on Google's grounding; "${AI.chat.search.model}" is ${vendor}`);
  }
  const google = googleProvider();
  return {
    model: google.chat(id),
    // Grounding takes no result count — the model decides how much to read, and
    // `maxResults` is spent only on the OpenRouter path above.
    tools: { google_search: google.tools.googleSearch({}) },
  };
}

/** The writer behind `write`: drafts one section from the agent's brief. */
export function writerModel(): ModelCall {
  const { model, effort } = AI.chat.writer;
  if (viaOpenRouter()) {
    return {
      model: openrouter().chat(model, { usage: { include: true }, reasoning: { effort } }),
    };
  }
  return direct(model, effort);
}

/** The model that expands `<nt-build-diagram>` into canvas HTML. */
export function diagramModel(): ModelCall {
  if (viaOpenRouter()) {
    return {
      model: openrouter().chat(AI.diagram.model, {
        // Pinned, never the provider's default — this line reasons hard when
        // left to itself, and a drawing lane lives on time-to-first-shape.
        reasoning: { effort: AI.diagram.effort },
      }),
    };
  }
  // The same pin, in whichever dialect the diagram model's own vendor speaks.
  return direct(AI.diagram.model, AI.diagram.effort);
}

/**
 * A slug on its own vendor's adapter, with the effort dial in that vendor's
 * words: Anthropic's effort, OpenAI's reasoning effort, Gemini's thinking
 * level. Chosen by the slug's vendor, never by the lane — a lane that assumed
 * its vendor sent the next model it was moved to down the wrong wire, under a
 * name that vendor does not answer to (NT-87).
 */
function direct(slug: string, effort: Effort): ModelCall {
  const { vendor, id } = directModel(slug);
  switch (vendor) {
    case "anthropic":
      return { model: anthropic()(id), providerOptions: { anthropic: { effort } } };
    case "openai":
      // The Responses API, which is the adapter's default: OpenAI's chat
      // completions take no tools from a model that is reasoning.
      return { model: openai()(id), providerOptions: { openai: { reasoningEffort: effort } } };
    case "google":
      return {
        model: googleProvider().chat(id),
        providerOptions: { google: { thinkingConfig: { thinkingLevel: effort } } },
      };
    case "recraft":
      throw new Error(`"${slug}" is an image model, not a language model`);
  }
}

/** The effort levels every direct vendor accepts under its own name. */
type Effort = "low" | "medium" | "high";

/** Adds a lane's own options for its vendor to what `direct` set. */
function withOptions(
  call: ModelCall,
  vendor: "anthropic" | "openai",
  options: Record<string, JSONValue>,
): ModelCall {
  return {
    ...call,
    providerOptions: {
      ...call.providerOptions,
      [vendor]: { ...call.providerOptions?.[vendor], ...options },
    },
  };
}

function openrouter() {
  return createOpenRouter({ apiKey: apiKey("openrouter") });
}

function anthropic() {
  return createAnthropic({ apiKey: apiKey("anthropic") });
}

function openai() {
  return createOpenAI({ apiKey: apiKey("openai") });
}

function googleProvider() {
  return createGoogleGenerativeAI({ apiKey: apiKey("google") });
}
