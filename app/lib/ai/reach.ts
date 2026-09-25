import { AI } from "./aiConfig";

/**
 * How far ambient completion reaches, from 0 — Complete: only finish what you
 * started — to 1 — Create: write what is not there yet.
 *
 * A dial between the two measured ends rather than a switch between them. The
 * numbers slide; the two things that are not quantities are halves of the dial:
 * blocks are proposed only in the Create half, and the grounding gate only acts
 * in the Complete half — the gate cuts to a clause, which would cut a block's
 * markup in two, so the two must never meet.
 */
export type SuggestionLimits = {
  debounceMs: number;
  minContextChars: number;
  /** Blocks (code, math, diagram) may be proposed. */
  allowBlocks: boolean;
  maxChars: number;
  /** Share of the completion's content words that must already be on the page. */
  minGrounding: number;
};

export const DEFAULT_REACH = 0.5;

export function clampReach(reach: number): number {
  return Number.isFinite(reach) ? Math.min(1, Math.max(0, reach)) : DEFAULT_REACH;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function suggestionLimits(reach: number): SuggestionLimits {
  const t = clampReach(reach);
  const { complete, create } = AI.reach;
  return {
    debounceMs: Math.round(lerp(complete.debounceMs, create.debounceMs, t)),
    minContextChars: Math.round(lerp(complete.minContextChars, create.minContextChars, t)),
    allowBlocks: t >= 0.5,
    maxChars: Math.round(lerp(complete.maxChars, create.maxChars, t)),
    minGrounding: t >= 0.5 ? 0 : lerp(complete.minGrounding, 0, t * 2),
  };
}
