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
    /**
     * Structure spans many lines. A five-node flowchart with labelled edges
     * runs past 160 tokens, and truncation silently drops the trailing edges —
     * which reads as "the diagram lost its arrows".
     */
    htmlMaxTokens: 420,
  },

  timing: {
    ghostDebounceMs: 350,
    /**
     * How long the streaming head stays lit at minimum. Short prose usually
     * arrives in a single chunk — measured, the head was being shown and torn
     * down 1ms apart, so the glow never rendered at all. Holding it briefly
     * turns that into an "it just landed" beat, and long streams are unaffected
     * because they exceed this on their own.
     */
    minStreamHeadMs: 450,
  },

  /**
   * Visible characters before the caret needed before we complete at all. Too
   * low and a couple of characters is enough to provoke a whole block — typing
   * "a =" was proposing a math block before there was anything to go on.
   */
  minContextChars: 14,

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
