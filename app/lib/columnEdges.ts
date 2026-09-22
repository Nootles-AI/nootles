import { useLayoutEffect, type RefObject } from "react";

/**
 * The document column's edges, as distances from the window's left and right,
 * for the boxes fixed to the window that fill or centre on the column: the
 * tool dock, the expanded stage, a storyboard shot at full size.
 *
 * The shell publishes them; each such box follows them, and they are written
 * onto that box alone as `--nt-stage-l` / `--nt-stage-r`. Not onto `:root`:
 * they change on every frame a rail opens or closes, and a custom property on
 * the root is inherited by every element in the document — on a long page
 * that restyled ~9,000 elements a frame, where a follower restyles a handful.
 *
 * With no shell around (a shared page) nothing is published, the properties
 * stay unset, and each box falls back to the whole window.
 */
export interface ColumnEdges {
  left: number;
  right: number;
}

let edges: ColumnEdges | null = null;
const followers = new Set<HTMLElement>();

function paint(el: HTMLElement, at: ColumnEdges | null): void {
  if (at) {
    el.style.setProperty("--nt-stage-l", `${at.left}px`);
    el.style.setProperty("--nt-stage-r", `${at.right}px`);
  } else {
    el.style.removeProperty("--nt-stage-l");
    el.style.removeProperty("--nt-stage-r");
  }
}

/** The shell's side: the column has moved, or there is no longer a shell. */
export function publishColumnEdges(next: ColumnEdges | null): void {
  if (next && edges && next.left === edges.left && next.right === edges.right) return;
  edges = next;
  for (const el of followers) paint(el, next);
}

/** Keep `el` on the column's edges until the returned function is called. */
export function followColumnEdges(el: HTMLElement): () => void {
  followers.add(el);
  paint(el, edges);
  return () => {
    followers.delete(el);
    paint(el, null);
  };
}

/** {@link followColumnEdges} for as long as the element is mounted. */
export function useColumnEdges(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    return el ? followColumnEdges(el) : undefined;
  }, [ref]);
}
