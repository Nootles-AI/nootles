import type { CanvasTool } from "../engine/shortcuts";
import type { ToolControl } from "../render/CanvasSurface";

export type PageToolSnapshot = { readonly tool: CanvasTool; readonly locked: boolean };

/**
 * The page's one tool, shared by the bar and every diagram on the page.
 *
 * A tool is good for one use: a shape drawn, a path finished, a connector
 * landed, and the page is back on Move. A double-click on a tool locks it so a
 * run of shapes costs one pick; any single pick — Escape included, which picks
 * Move — lets the lock go. Move itself is never locked: it is where settling
 * lands, and a locked Move would leave Escape nothing to do but spend itself.
 */
export interface PageToolControl extends ToolControl {
  /** The tool and its lock, as one immutable value for `useSyncExternalStore`. */
  snapshot(): PageToolSnapshot;
  locked(): boolean;
  lock(tool: CanvasTool): void;
  /** After one use: back to Move, unless the tool in hand is locked. */
  settle(): void;
}

const MOVE: PageToolSnapshot = { tool: "move", locked: false };

export function createPageTools(): PageToolControl {
  let state = MOVE;
  const listeners = new Set<() => void>();

  const write = (next: PageToolSnapshot) => {
    if (next.tool === state.tool && next.locked === state.locked) return;
    state = next.tool === "move" ? MOVE : next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => state.tool,
    snapshot: () => state,
    locked: () => state.locked,
    set: (tool) => write({ tool, locked: false }),
    lock: (tool) => {
      if (tool !== "move") write({ tool, locked: true });
    },
    settle: () => {
      if (!state.locked) write(MOVE);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
