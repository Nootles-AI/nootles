"use client";

import { createContext, useContext } from "react";

/**
 * Lets a shape deep inside the canvas reach the surrounding document text, so
 * label completion can be informed by what the page says around the diagram —
 * not just by the diagram itself.
 */
export type CanvasAi = {
  /** Text of the blocks just before this canvas, newest last. */
  getDocContext: () => string;
};

export const CanvasAiContext = createContext<CanvasAi | null>(null);

export function useCanvasAi(): CanvasAi | null {
  return useContext(CanvasAiContext);
}
