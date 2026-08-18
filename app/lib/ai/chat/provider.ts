import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
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
        // Never left to the provider's default: unset, this model reasons at
        // full effort and spends minutes before the first token.
        reasoning: { effort: AI.chat.effort },
      }),
    };
  }
  const { id } = directModel(AI.chat.model);
  return {
    model: openai()(id),
    // The same dial as above, where OpenAI's own API takes it. Usage needs no
    // asking for here — the adapter reports it, cache reads included.
    providerOptions: { openai: { reasoningEffort: AI.chat.effort } },
  };
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
  const google = googleProvider();
  const { id } = directModel(AI.chat.search.model);
  return {
    model: google.chat(id),
    // Grounding takes no result count — the model decides how much to read, and
    // `maxResults` is spent only on the OpenRouter path above.
    tools: { google_search: google.tools.googleSearch({}) },
  };
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
  const { id } = directModel(AI.diagram.model);
  return {
    model: googleProvider().chat(id),
    // The same pin, in Gemini's own vocabulary: a thinking level rather than a
    // reasoning effort, and the level is the dial `AI.diagram.effort` sets.
    providerOptions: { google: { thinkingConfig: { thinkingLevel: AI.diagram.effort } } },
  };
}

function openrouter() {
  return createOpenRouter({ apiKey: apiKey("openrouter") });
}

function openai() {
  return createOpenAI({ apiKey: apiKey("openai") });
}

function googleProvider() {
  return createGoogleGenerativeAI({ apiKey: apiKey("google") });
}
