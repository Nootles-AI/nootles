/**
 * Single tuning surface for the AI layer. Model ids, timings and heuristic
 * thresholds live here so behaviour can be tuned in one file.
 *
 * The suggestion pipeline is a 3-tier filter — most keystrokes never leave the
 * browser:
 *   Tier 0  local heuristics   0ms, free      → ~90% stop here
 *   Tier 1  binary gate       ~250ms, ~$0.00005 → "worth interrupting? default NO"
 *   Tier 2  content           routed by kind (local / FIM / strong model)
 */

export const AI = {
  /** Tier 1. Groq-hosted 8B via OpenRouter: ~0.21s round trip, measured. */
  gate: {
    model: "meta-llama/llama-3.1-8b-instruct",
    // Pin the fastest host; allow fallback so a Groq outage degrades, not breaks.
    provider: { order: ["Groq"], allow_fallbacks: true },
    // Warm P50 is ~130ms but the tail exceeds 600ms; clipping there turns a
    // real YES into a silent miss, which reads as "dumb". Tier 0 has already
    // found a genuine candidate, so tolerate the tail rather than drop it.
    timeoutMs: 1200,
  },

  /** Tier 2, the only expensive branch (diagrams). */
  planner: {
    model: "anthropic/claude-sonnet-4.6",
    maxOutputTokens: 700,
  },

  /** Tier 2 content for code/math, and the inline ghost lane. */
  fim: {
    model: "codestral-2508",
    ghostMaxTokens: 32,
    contentMaxTokens: 256,
  },

  timing: {
    ghostDebounceMs: 350,
    /** Only the network is debounced; heuristics run on every change. */
    actionDebounceMs: 600,
  },

  projection: {
    /** Blocks either side of the cursor included in the prompt text. */
    window: 4,
  },

  heuristics: {
    minConfidence: 0.55,
    /** A run of short unpunctuated siblings this long reads as a list. */
    listMinItems: 3,
    listMaxItemChars: 60,
    headingMaxChars: 50,
    headingMaxWords: 8,
    /** The paragraph after a candidate heading must be at least this long. */
    headingNextMinChars: 80,
    diagramMinChars: 40,
  },

  /** Re-pausing in the same spot is common; replay instantly. */
  cache: { max: 50 },

  /**
   * Languages the code block can actually highlight. Kept here (rather than
   * imported from codemirror/languages.ts) so the pure heuristics module stays
   * free of client-only imports. Anything detected outside this set falls back
   * to plaintext.
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

/** Clamp a detected language to one the editor can render. */
export function normalizeLanguage(lang: string | undefined): string {
  if (!lang) return "plaintext";
  const l = lang.toLowerCase();
  if (AI.codeLanguages.includes(l)) return l;
  if (l === "ts") return "typescript";
  if (l === "js" || l === "node") return "javascript";
  if (l === "py") return "python";
  return "plaintext";
}
