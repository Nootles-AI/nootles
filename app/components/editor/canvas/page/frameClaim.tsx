"use client";

import { createContext, useContext } from "react";
import type { CanvasApi } from "../render/CanvasSurface";

/**
 * A storyboard shot the screen is speaking for — `${blockId}:${i}` for a tile,
 * `${blockId}:fs${i}` for the full-size view.
 *
 * Diagrams on the page need no claim: whichever holds the selection is the one
 * the panels and the bar speak for. A shot is a fixed frame with its own tools
 * and its own keys, so it is taken, one at a time; taking one lets the page's
 * selection go, and a selection on the page lets the shot go.
 */
export type ActiveFrame = { key: string; api: CanvasApi };

export type FrameClaim = {
  frame: ActiveFrame | null;
  claim: (next: ActiveFrame | null) => void;
};

/** A board outside the workspace — a harness, the NML view — has nobody to claim. */
const NO_CLAIM: FrameClaim = { frame: null, claim: () => {} };

export const FrameClaimContext = createContext<FrameClaim>(NO_CLAIM);

export function useFrameClaim(): FrameClaim {
  return useContext(FrameClaimContext);
}
