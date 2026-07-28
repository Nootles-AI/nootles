/**
 * Single tuning surface for the AI layer.
 *
 * There is one inline-suggestion lane: the document is serialized into the
 * auto-board HTML language, split at the caret, and a fill-in-the-middle model
 * completes the middle. Nothing classifies intent — a code block is what comes
 * next in the grammar, not a decision some rule makes — so there is no gate,
 * router, or heuristic left to configure.
 */

export const AI = {
  fim: {
    model: "codestral-2508",
    /** Prose completions are bounded by the suffix, so they stay short. */
    ghostMaxTokens: 32,
    /** Structure spans several lines. */
    htmlMaxTokens: 160,
  },

  timing: {
    ghostDebounceMs: 350,
  },

  projection: {
    /** Blocks either side of the cursor included in the prompt. */
    window: 4,
  },

  /**
   * Languages the code block can actually highlight. Kept here (rather than
   * imported from codemirror/languages.ts) so pure modules stay free of
   * client-only imports. Anything outside this set falls back to plaintext.
   */
  codeLanguages: [
    "plaintext",
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "python",
    "json",
    "html",
    "css",
    "markdown",
    "sql",
    "rust",
  ] as readonly string[],
} as const;

/** Clamp a language the model wrote to one the editor can render. */
export function normalizeLanguage(lang: string | undefined): string {
  if (!lang) return "plaintext";
  const l = lang.toLowerCase();
  if (AI.codeLanguages.includes(l)) return l;
  if (l === "ts") return "typescript";
  if (l === "js" || l === "node") return "javascript";
  if (l === "py") return "python";
  return "plaintext";
}
