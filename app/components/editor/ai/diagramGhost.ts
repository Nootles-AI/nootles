import { bandHeight, EMPTY_BAND_H } from "@/app/components/editor/canvas/scene/band";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import type { Suggestion } from "./ghostText";

/**
 * Where a diagram suggestion is in its life, read off the suggestion itself so
 * there is no second state to keep in step with it.
 *
 * - `thinking` — the brief is out and no shape has come back.
 * - `drawing` — shapes are arriving; Tab places what has come so far.
 * - `waiting` — finished and compiled; Tab inserts it, Escape dismisses it.
 */
export type DiagramPhase = "thinking" | "drawing" | "waiting";

export function diagramPhase(s: Suggestion): DiagramPhase | null {
  if (s?.kind !== "action") return null;
  if (s.preview?.kind === "diagram") return s.batch ? "waiting" : "drawing";
  // Only the diagram lane sets `loading` (see `Suggestion`).
  return s.loading ? "thinking" : null;
}

/**
 * The height the ghost's band stands at: while thinking, an empty diagram's —
 * the room a new band opens with — and from the first shape on, the band's
 * own, so the ghost is exactly as tall as what Tab would land.
 */
export function ghostBandHeight(phase: DiagramPhase, scene: Scene | null): number {
  if (phase === "thinking" || !scene) return EMPTY_BAND_H;
  return bandHeight(scene);
}

/**
 * The words the caret line says after the ghost caret. Thinking says none
 * there: the band says it ({@link PLANNING_LABEL}), since there is nothing in
 * it yet. Waiting has keys to offer instead of words.
 */
export function phaseWord(phase: DiagramPhase): string | null {
  return phase === "drawing" ? "Drawing diagram" : null;
}

/** What the empty band says while the model plans, where the shapes will come. */
export const PLANNING_LABEL = "Planning diagram";
