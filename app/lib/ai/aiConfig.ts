/**
 * Single tuning surface for the AI layer.
 *
 * There is one inline-suggestion lane: the document is serialized into the
 * Nootles HTML language, split at the caret, and a fill-in-the-middle model
 * completes the middle. Nothing classifies intent — a code block is what comes
 * next in the grammar, not a decision some rule makes — so there is no gate,
 * router, or heuristic left to configure.
 */

export const AI = {
  fim: {
    model: "codestral-2508",
    /**
     * Token budget per completion SHAPE, which the caller states in its
     * request.
     *
     * One budget for every caller is what let a completion run away: every
     * editor request asked for structure, so a one-clause prose continuation
     * was allowed the whole structural budget with no stop sequence, and a
     * model that started repeating itself had nothing to stop it.
     */
    maxTokens: {
      /** "complete": the few words the page already implies, and no more. */
      complete: 64,
      /** Prose where a block would be cut anyway — inside a table cell. */
      prose: 96,
      /**
       * Structure spans many lines. A five-node flowchart with labelled edges
       * runs past 160 tokens, and truncation silently drops the trailing edges —
       * which reads as "the diagram lost its arrows".
       */
      structure: 420,
    },
    /**
     * How much of the document the model is shown either side of the caret.
     * The wire call enforces it; the callers cut to the same numbers, so a page
     * carrying one very large block does not upload what is about to be
     * trimmed off again.
     */
    maxBefore: 4000,
    maxAfter: 1000,
    /**
     * How much of the project's standing context rides the completion seed —
     * the sheet's answers and the head of each context file, so a completion
     * can use the project's own names and facts. Part of the seed because the
     * seed is the one thing exempt from `MAX_BEFORE`; capped because the seed
     * prefixes EVERY completion, and this lane is priced per keystroke.
     */
    context: {
      /** Per file, so one long file cannot spend the whole allowance. */
      fileHeadChars: 600,
      maxChars: 2400,
    },
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
   *
   * Moved off 2.5 (2026-08): Google retired it, answering 404 "no longer
   * available" from 9 July, months before the announced October shutdown. The
   * aggregator had been quietly remapping the dead slug, so the lane only
   * broke when it was called directly — the measurements above are 2.5's and
   * want redoing. 3.7 because the diagram lane already runs on it and it is
   * cheaper per output token than the model it replaces.
   */
  reformat: {
    model: "google/gemini-3.7-flash",
    /**
     * How long the ANSWER may be — three candidates of rewritten HTML. What a
     * thinking model needs on top of it is added at the wire, in `providers.ts`,
     * because it is a fact about Gemini and not about this lane: 3.7 spends its
     * reasoning inside the same ceiling, so for a while this number was really
     * a thinking budget and every run longer than a few lines came back
     * truncated, unparsable, and indistinguishable from "nothing fits".
     */
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
   * Terra at medium effort, measured against Sonnet 4.6 on OpenRouter's own
   * prices: the same intelligence (46 against 47 on Artificial Analysis) for a
   * third of the cost ($1/$6 against $3/$15), and it keeps the long-context
   * recall this loop lives on — 89.6% MRCR at 256-512K, two points off the
   * flagship.
   *
   * The effort dial is the whole choice. Max scores eight points higher than
   * Sonnet but spends ~170s before the first token, which no chat surface can
   * wear; medium buys the saving instead of the headroom. Luna is cheaper again
   * and collapses to 41.3% on that same recall benchmark — the one thing a loop
   * that reads pages cannot give up.
   */
  chat: {
    model: "openai/gpt-5.6-terra",
    /** The dial above, traded against time-to-first-token. */
    effort: "medium",
    /**
     * Ceiling on tool round-trips in one turn. Editing several pages costs a
     * step each for open/read/edit, so this is roughly "touch six pages", with
     * headroom for the model to re-read after a failed validation.
     */
    maxSteps: 24,
    /** Cap on a single `read_page` result, so one long page can't eat the window. */
    maxPageChars: 24_000,
    /**
     * How much of a page read from an EARLIER turn the model still gets to see.
     * Enough for the first line — what an edit did, or the title a read opened
     * with — and not the page itself, which has moved on. See `transcript.ts`.
     */
    staleReadChars: 200,
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
     * which Flash does in ~2.3s with citations — asking the chat model to do it
     * would cost a second long-context call per search for no better answer.
     *
     * On 3.7 for the reason `reformat` is: 2.5 is retired, and this lane died
     * with it the moment the aggregator stopped covering for the dead slug.
     */
    search: {
      model: "google/gemini-3.7-flash",
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

  /**
   * The diagram builder — the second stage of the completion lane.
   *
   * The FIM model writes `<nt-build-diagram>` where a diagram belongs and says
   * in a phrase what it is for; this model turns that phrase into canvas HTML.
   * Split because the two jobs want opposite things: the ambient lane is asked
   * on every keystroke and must stay cheap, while the canvas grammar is seven
   * kinds, an attribute/CSS split and a set of rules — teaching that in the FIM
   * preamble would cost it on every prose completion, and `MAX_BEFORE` trims
   * the preamble first anyway.
   *
   * Flash for the same reason `reformat` uses it: measured fastest of the three
   * on a structured-rewrite task, and the only one that read a numbered
   * sequence as a diagram. Swapping it is this one line.
   */
  diagram: {
    /**
     * Switched from Gemini 2.5 Flash (2026-08): 3.7 Flash sits in the top
     * drawing tier of the current generation (Willison's Aug-16 SVG eval) while
     * being flash-latency, streamable and — unusually for an upgrade — cheaper
     * per token than 2.5. Claude Fable 5 draws better still but at ~25x the
     * price and chat-lane latency; if a "redraw this frame beautifully" action
     * ever ships, it is the model for that button, not for this lane.
     */
    model: "google/gemini-3.7-flash",
    /**
     * Reasoning budget. Low, like every other Gemini lane that answers a pause
     * in typing: medium was measured in the ledger at 13-49s per diagram with
     * 2,600-6,100 output tokens — most of it thinking spent before the first
     * shape, which is exactly the phase this lane's streaming preview cannot
     * hide. 2.5 Flash drew a whole diagram in under 5s; low is the closest 3.7
     * can be pinned to that, since it cannot be told to stop thinking at all.
     */
    effort: "low",
    /**
     * A drawing is the long case, and by a wide margin. A mockup is a few dozen
     * short elements; a storyboard is one `<nt-path>` per stroke, and a `d` with
     * a dozen curves in it is 200 tokens on its own. Truncation loses the
     * closing tags, which reads as "half the drawing is missing" — and the
     * shapes that did arrive are kept, so the cost of being wrong here is a
     * diagram that looks finished and is not.
     */
    maxTokens: 7000,
    /**
     * How much of the page the builder is shown, taken from just before the
     * caret. It needs the wording to label shapes with what the page actually
     * calls things; it does not need the whole document.
     */
    contextChars: 2000,
    /**
     * The vector specialist behind the chat's draw tool — generates NATIVE
     * SVG rather than a traced raster, so its drawings import as editable
     * scene paths. It must stay a VECTOR line: this lane reads the response as
     * text and hands it to `importSvgScene`, so a raster model of any
     * generation returns bytes it cannot parse, and every drawing misses.
     * V3 because it is the ONLY generation that takes them: Recraft's API
     * reference says styles "are not yet supported for V4 models", and puts
     * `controls.artistic_level` [0-5] at V3 only. Both are what the picker is
     * built on (`drawStyles.ts`), so V4 would cost the style card its meaning
     * — and not save anything, the vector lines all being $0.08 an image. Scenes and
     * storyboard shots go here; structured diagrams stay on the LLM above,
     * whose labels land as text where a vector model would paint them as
     * outlines. Flat-priced per image, hence `perCall` in the ledger rather
     * than token prices.
     */
    vector: {
      model: "recraft/recraft-v3",
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
      /**
       * Ghost text past this is not a continuation any more. Finite because
       * this is the only bound inside the read loop: unbounded, a model that
       * started looping was drawn in full and billed in full.
       */
      maxChars: 300,
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
   * USD per 1M tokens, for the `aiCalls` cost ledger. Provider list prices —
   * re-check when a model line above changes, they drift.
   */
  prices: {
    "codestral-2508": { in: 0.3, out: 0.9 },
    // Retired by Google in July 2026 and kept for the same reason as the two
    // below: every row is priced by the model that actually served it.
    "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
    "google/gemini-3.7-flash": { in: 0.375, out: 1.875 },
    "openai/gpt-5.6-terra": { in: 1, out: 6, cacheRead: 0.1, cacheWrite: 1.25 },
    // Flat per image, not per token — `perCall` is the whole price. This is the
    // VECTOR line's price; $0.04 is what Recraft charges for the raster model of
    // the same generation, and pricing this lane at it halved every drawing.
    "recraft/recraft-v3": { in: 0, out: 0, perCall: 0.08 },
    // Kept after the switch to V3: rows served by V4 still price by V4.
    "recraft/recraft-v4-vector": { in: 0, out: 0, perCall: 0.08 },
    // Kept after the switch away: the ledger prices each row by the model that
    // served it, so removing this would silently un-cost every earlier chat.
    "anthropic/claude-sonnet-4.6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  } as Record<
    string,
    {
      in: number;
      out: number;
      cacheRead?: number;
      cacheWrite?: number;
      /** USD per call, for models priced per image rather than per token. */
      perCall?: number;
    }
  >,

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
