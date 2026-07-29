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

  /**
   * Reformat suggestions for a finished block. A transformation rather than a
   * continuation, so this is a few-shot instruct call, not fill-in-the-middle.
   *
   * Gemini Flash was measured against Haiku 4.5 and GPT-4.1-mini on the real
   * task: fastest of the three (0.5-1.3s), and the only one to read "x squared
   * plus 2x plus 1" as a math block and a numbered sequence as a diagram —
   * the others fell back to a bullet list. All three correctly declined on
   * ordinary prose, which is the case that matters most.
   */
  reformat: {
    model: "google/gemini-2.5-flash",
    maxTokens: 900,
    /** More than three chips is a menu, not a suggestion. */
    maxCandidates: 3,
    /** Quiet time before asking — a pause counts as finishing. */
    debounceMs: 900,
    /**
     * Runs shorter than this are not worth asking about. Deliberately low: the
     * model declines on its own far more reliably than a character count can,
     * and a compact table ("i | i + 2 / 0 | 2 / 1 | 3") is only 27 characters —
     * a stricter gate threw the clearest cases away before ever asking.
     */
    minChars: 12,
    /**
     * How many consecutive paragraphs to consider as one thing. Pressing Enter
     * starts a new block, so a pasted snippet or a typed table arrives as
     * several — but past a point a "run" is just the document.
     */
    maxBlocks: 12,
    /**
     * How much of a block's wording a candidate must carry before applying that
     * candidate is allowed to remove the block. Candidates cover different
     * amounts of a run, and offering the whole run to every one of them deleted
     * the blocks a candidate never mentioned.
     *
     * Measured over real candidates: blocks a candidate absorbed score 0.67-1.0
     * (folding "Sam owns ingest" into cells drops "owns" into the header),
     * untouched blocks score 0.0. The gap is wide, and erring low only leaves a
     * block behind — visible, undoable — where erring high destroys text.
     */
    consumedRatio: 0.5,
  },

  /**
   * The chat agent. A different job from the ambient lanes: it runs a tool loop
   * over the whole project rather than completing one caret position, so it
   * wants reasoning and long-context reliability over latency.
   *
   * Verified live against OpenRouter's model list; `claude-sonnet-5` and
   * `claude-opus-5` are also available on the same key if this proves too weak
   * at long multi-step edits — switching is this one line.
   */
  chat: {
    model: "anthropic/claude-sonnet-4.6",
    /**
     * Ceiling on tool round-trips in one turn. Editing several pages costs a
     * step each for open/read/edit, so this is roughly "touch six pages", with
     * headroom for the model to re-read after a failed validation.
     */
    maxSteps: 24,
    /** Cap on a single `read_page` result, so one long page can't eat the window. */
    maxPageChars: 24_000,
    /**
     * How long `open_page` waits for a page's editor to catch up with the
     * server. The wait itself is a round trip; this is only the point at which a
     * page that is never going to load fails one tool call instead of hanging
     * the turn behind it.
     */
    editorWaitMs: 10_000,
    /**
     * The web search behind `search_web`. A separate, cheap model on purpose:
     * the searching model only has to read result pages and answer from them,
     * which Flash does in ~2.3s with citations — asking Sonnet to do it would
     * cost a second long-context call per search for no better answer.
     */
    search: {
      model: "google/gemini-2.5-flash",
      maxResults: 5,
    },
    /**
     * What the composer will take from a drag, a paste or the file button.
     *
     * The byte cap is the vision providers' own: Anthropic refuses an image
     * past 5MB once base64 has inflated it by a third, so the file itself has
     * to stay under ~3.7MB. The character cap is the window's: a text file is
     * inlined into the message verbatim, so a long one is spent context on
     * every later turn of the thread, not just the turn it was attached to.
     */
    attachments: {
      maxBytes: 3_500_000,
      maxTextChars: 60_000,
    },
  },

  review: {
    /**
     * Quiet time before the set of blocks the user has rewritten inside a
     * pending change reaches its row. Keystrokes are not worth a mutation each,
     * and the only thing lost to a reload inside the window is one block's
     * Discard button coming back.
     */
    editedFlushMs: 700,
  },

  /**
   * Per-page eagerness. "create" is the default — the model writes what is not
   * there yet. "complete" only finishes what you started: it cannot know what
   * comes next while you are taking notes on something, so an ungrounded guess
   * is invention no matter how good the model is.
   *
   * Complete does not switch suggestions off. It raises the bar to things
   * actually derivable from the page. Thresholds come from measured
   * completions: genuinely inferable ones (finishing a series, finishing a
   * word) came back at 7-25 characters and reused the page's own vocabulary,
   * while invented ones ran 38-70 characters at ZERO overlap — and tended to
   * parrot the preamble's example identifiers, the tell that the model had
   * nothing to go on.
   */
  modes: {
    create: {
      debounceMs: 350,
      minContextChars: 14,
      /** Blocks (code, math, diagram) may be proposed. */
      allowBlocks: true,
      maxChars: Infinity,
      minGrounding: 0,
    },
    complete: {
      debounceMs: 700,
      minContextChars: 40,
      allowBlocks: false,
      /** One clause, never a paragraph. */
      maxChars: 90,
      /**
       * Share of the completion's content words that already appear on the
       * page. Invented continuations measured 0.00; a series continuation
       * measured 1.00. Half is a deliberately blunt line between them.
       */
      minGrounding: 0.5,
    },
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
    "java",
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
