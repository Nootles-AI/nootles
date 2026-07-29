import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { AI } from "../aiConfig";

/**
 * The chat model, built per request.
 *
 * Server-only: this reads `OPENROUTER_API_KEY`, which must never reach the
 * browser. That is the whole reason the agent loop streams from a route rather
 * than running the provider client-side, even though the tools that edit the
 * document execute in the browser.
 */
export function chatModel() {
  return openrouter().chat(AI.chat.model);
}

/** The model behind `search_web`, which reads result pages rather than reasons. */
export function searchModel() {
  return openrouter().chat(AI.chat.search.model);
}

function openrouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  return createOpenRouter({ apiKey });
}
