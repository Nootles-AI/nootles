/**
 * How the document's own keys reach the diagrams on its page, without the
 * editor knowing anything about a canvas: each pane registers what its
 * diagrams do, and the editor asks through the element a key landed in.
 */

export interface PaneDiagrams {
  /**
   * Enter on a selected diagram block: into its shapes, or — an empty one —
   * the rectangle in hand. False when the block is not one of this pane's.
   */
  enter(blockId: string): boolean;
  /** A diagram the page's paste just made: its shapes selected, once it is up. */
  pasted(blockId: string): void;
}

const panes = new WeakMap<Element, PaneDiagrams>();

export function registerPaneDiagrams(pane: Element, diagrams: PaneDiagrams): () => void {
  panes.set(pane, diagrams);
  return () => {
    if (panes.get(pane) === diagrams) panes.delete(pane);
  };
}

const paneOf = (from: Element) => {
  const pane = from.closest(".nt-pane");
  return pane ? panes.get(pane) : undefined;
};

export function diagramEnter(from: Element, blockId: string): boolean {
  return paneOf(from)?.enter(blockId) ?? false;
}

export function diagramPasted(from: Element, blockId: string): void {
  paneOf(from)?.pasted(blockId);
}
