import { createAnthropic } from "@ai-sdk/anthropic";
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
  const { vendor, id } = directModel(AI.chat.model);
  if (vendor === "anthropic") {
    return {
      model: anthropic()(id),
      providerOptions: {
        anthropic: {
          effort: AI.chat.effort,
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
        },
      },
    };
  }
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

/** The writer behind `write`: drafts one section from the agent's brief. */
export function writerModel(): ModelCall {
  const { model, effort } = AI.chat.writer;
  if (viaOpenRouter()) {
    return {
      model: openrouter().chat(model, { usage: { include: true }, reasoning: { effort } }),
    };
  }
  const { vendor, id } = directModel(model);
  if (vendor === "anthropic") {
    return { model: anthropic()(id), providerOptions: { anthropic: { effort } } };
  }
  return {
    model: googleProvider().chat(id),
    providerOptions: { google: { thinkingConfig: { thinkingLevel: effort } } },
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

function anthropic() {
  return createAnthropic({ apiKey: apiKey("anthropic") });
}

function openai() {
  return createOpenAI({ apiKey: apiKey("openai") });
}

function googleProvider() {
  return createGoogleGenerativeAI({ apiKey: apiKey("google") });
}
