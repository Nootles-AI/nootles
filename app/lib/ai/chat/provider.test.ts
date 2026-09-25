import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Which wire each `ai`-package lane is built on, under both settings of
 * `USE_OPENROUTER`.
 *
 * Only the model objects are built: nothing here makes a call, so the keys are
 * stand-ins. The config is the real one, restored before each test, so a lane
 * can be moved to another vendor's model and the adapter it lands on checked (NT-87: the chat
 * moved to a model `DIRECT` had no line for, and threw on every request once
 * the flag was off).
 */

import { AI } from "../aiConfig";
import { chatTarget, imageTarget } from "../providers";
import { chatModel, diagramModel, searchModel, writerModel } from "./provider";

/** The real config, before a test moved a lane. */
let original: typeof AI;

beforeEach(() => {
  original ??= structuredClone(AI);
  Object.assign(AI, structuredClone(original));
  vi.stubEnv("OPENROUTER_API_KEY", "test-key-not-real");
  vi.stubEnv("OPENAI_API_KEY", "test-key-not-real");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-key-not-real");
  vi.stubEnv("RECRAFT_API_KEY", "test-key-not-real");
  vi.stubGlobal("fetch", () => {
    throw new Error("no network in this test");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Moves a lane to another model, as an edit to `aiConfig` would. */
const retarget = (lane: { readonly model: string }, slug: string) => {
  (lane as { model: string }).model = slug;
};

const wire = (model: LanguageModel) => {
  if (typeof model === "string") throw new Error("expected a model object");
  return { provider: model.provider, id: model.modelId };
};

/** The switch's values, as a deployment might spell them. */
const DIRECT_FLAGS = [undefined, "", "false", "0", "ture"];
const AGGREGATOR_FLAGS = ["true", "TRUE", " 1 ", "yes"];

describe.each(DIRECT_FLAGS)("USE_OPENROUTER=%j: every lane on its own vendor", (flag) => {
  beforeEach(() => {
    if (flag === undefined) delete process.env.USE_OPENROUTER;
    else vi.stubEnv("USE_OPENROUTER", flag);
  });

  test("the chat is GPT-6 Sol on OpenAI's Responses API, reasoning at the configured effort", () => {
    const call = chatModel();
    expect(wire(call.model)).toEqual({ provider: "openai.responses", id: "gpt-6-sol" });
    expect(call.providerOptions).toEqual({
      openai: {
        reasoningEffort: AI.chat.effort,
        reasoningSummary: "auto",
        store: false,
      },
    });
  });

  test("the writer, the diagram builder and search are Gemini, on Google's own key", () => {
    const writer = writerModel();
    expect(wire(writer.model)).toEqual({ provider: "google.generative-ai", id: "gemini-3.7-flash" });
    expect(writer.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: AI.chat.writer.effort } },
    });

    const diagram = diagramModel();
    expect(wire(diagram.model)).toEqual({ provider: "google.generative-ai", id: "gemini-3.7-flash" });
    expect(diagram.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: AI.diagram.effort } },
    });

    const search = searchModel(5);
    expect(wire(search.model)).toEqual({ provider: "google.generative-ai", id: "gemini-3.7-flash" });
    expect(Object.keys(search.tools ?? {})).toEqual(["google_search"]);
  });

  test("no lane asks for the aggregator's key", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => [chatModel(), writerModel(), diagramModel(), searchModel(5)]).not.toThrow();
  });

  test("a missing vendor key names the variable", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => chatModel()).toThrow("OPENAI_API_KEY is not set");
  });
});

describe.each(AGGREGATOR_FLAGS)("USE_OPENROUTER=%j: every lane through OpenRouter", (flag) => {
  beforeEach(() => vi.stubEnv("USE_OPENROUTER", flag));

  test("each lane asks OpenRouter for the slug as configured", () => {
    expect(wire(chatModel().model)).toEqual({ provider: "openrouter", id: AI.chat.model });
    expect(wire(writerModel().model)).toEqual({ provider: "openrouter", id: AI.chat.writer.model });
    expect(wire(diagramModel().model)).toEqual({ provider: "openrouter", id: AI.diagram.model });
    expect(wire(searchModel(5).model)).toEqual({ provider: "openrouter", id: AI.chat.search.model });
  });

  test("no lane asks for a vendor's own key", () => {
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
      vi.stubEnv(key, "");
    }
    expect(() => [chatModel(), writerModel(), diagramModel(), searchModel(5)]).not.toThrow();
  });
});

describe("the adapter follows the model's vendor, not the lane", () => {
  beforeEach(() => vi.stubEnv("USE_OPENROUTER", ""));

  test("a chat on Opus keeps its thinking settings on Anthropic's adapter", () => {
    retarget(AI.chat, "anthropic/claude-opus-5.5");
    const call = chatModel();
    expect(wire(call.model)).toEqual({ provider: "anthropic.messages", id: "claude-opus-5-5" });
    expect(call.providerOptions?.anthropic).toMatchObject({
      effort: AI.chat.effort,
      thinking: { type: "adaptive", display: "updates" },
      fallbacks: "default",
    });
    expect(call.providerOptions?.openai).toBeUndefined();
  });

  test("a chat on Gemini is Google's adapter, not OpenAI's", () => {
    retarget(AI.chat, "google/gemini-3.7-flash");
    const call = chatModel();
    expect(wire(call.model)).toEqual({ provider: "google.generative-ai", id: "gemini-3.7-flash" });
    expect(call.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: AI.chat.effort } },
    });
  });

  test("a diagram builder on an OpenAI model is OpenAI's adapter, not Google's", () => {
    retarget(AI.diagram, "openai/gpt-5.6-terra");
    const call = diagramModel();
    expect(wire(call.model)).toEqual({ provider: "openai.responses", id: "gpt-5.6-terra" });
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: AI.diagram.effort } });
  });

  test("a writer on Opus is Anthropic's adapter", () => {
    retarget(AI.chat.writer, "anthropic/claude-opus-5.5");
    const call = writerModel();
    expect(wire(call.model)).toEqual({ provider: "anthropic.messages", id: "claude-opus-5-5" });
    expect(call.providerOptions).toEqual({ anthropic: { effort: AI.chat.writer.effort } });
  });

  test("search off Google says why rather than grounding on the wrong vendor", () => {
    retarget(AI.chat.search, "openai/gpt-6-sol");
    expect(() => searchModel(5)).toThrow(/search_web runs on Google's grounding/);
  });

  test("an image model is refused as a language model", () => {
    retarget(AI.diagram, "recraft/recraft-v3");
    expect(() => diagramModel()).toThrow(/image model/);
  });

  test("an unmapped slug names the table to add it to", () => {
    retarget(AI.chat, "meta/muse-spark-1.3");
    expect(() => chatModel()).toThrow(/No direct route for "meta\/muse-spark-1.3"/);
  });
});

/**
 * The routing table against the config as shipped. A lane moved to a model
 * with no direct line fails here, in CI, rather than as a 500 in whichever
 * deployment runs without the aggregator.
 */
describe.each([...DIRECT_FLAGS, ...AGGREGATOR_FLAGS])(
  "USE_OPENROUTER=%j: every configured model is reachable",
  (flag) => {
    beforeEach(() => {
      if (flag === undefined) delete process.env.USE_OPENROUTER;
      else vi.stubEnv("USE_OPENROUTER", flag);
    });

    test.each([
      ["chat", () => chatModel()],
      ["chat writer", () => writerModel()],
      ["search_web", () => searchModel(AI.chat.search.maxResults)],
      ["diagram builder", () => diagramModel()],
      ["reformat, categorize, feedback", () => chatTarget(AI.reformat.model, 16)],
      ["comments gate", () => chatTarget(AI.commentsGate.model, 4)],
      ["album captions", () => chatTarget(AI.album.model, AI.album.answerTokens)],
      ["repo naming", () => chatTarget(AI.context.nameModel, AI.context.answerTokens)],
      ["drawing", () => imageTarget(AI.diagram.vector.model)],
    ])("%s", (_lane, build) => {
      expect(build).not.toThrow();
    });
  },
);
