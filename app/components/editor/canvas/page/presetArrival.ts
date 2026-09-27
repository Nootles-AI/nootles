/**
 * A chosen preset arrives the way a suggested diagram does (`GhostBand`): the
 * band opens from its empty height under its own clip, and what the preset
 * brought fades in from a blur, one piece after another. Only the pick plays
 * it — the ops have already landed, whole, as one step; this marks the
 * elements they drew and lets go of them, so nothing waits on it and an undo,
 * a redo or a remote edit arrives as it always has. The opening itself is the
 * band's own height glide (`bandMotion`), which every committed height plays;
 * this clips its growing edge while it runs.
 */

import { bandGlide } from "../render/bandMotion";
import type { EdgeId, NodeId } from "../scene/types";

/** The gap between one piece's entrance and the next's. */
export const ARRIVE_STAGGER_MS = 30;
/** Pieces past this many come in with the last of them, so a big preset is no slower. */
export const ARRIVE_STAGGER_CAP = 8;
/** The longest entrance the stylesheet plays (`canvas.css`) on a piece. */
const ARRIVE_MS = 240;

/** When each of `count` pieces starts, in document order. */
export function arrivalDelays(count: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.min(i, ARRIVE_STAGGER_CAP) * ARRIVE_STAGGER_MS);
}

/**
 * Plays the entrance on this band over the shapes and connectors the pick
 * added. Call once they are drawn and before the frame paints. Nothing under
 * reduced motion.
 */
export function playArrival(
  band: HTMLElement,
  scene: HTMLElement,
  nodes: readonly NodeId[],
  edges: readonly EdgeId[],
): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // Shapes in the scene's order, then each connector with its label.
  const shape = (id: NodeId) => scene.querySelector<HTMLElement>(`:scope > [data-id="${CSS.escape(id)}"]`);
  const pieces: (HTMLElement | SVGElement)[][] = [
    ...nodes.map((id) => [shape(id)]),
    ...edges.map((id) => {
      const key = CSS.escape(id);
      return [
        scene.querySelector<SVGElement>(`.nt-edge-line[data-edge="${key}"]`)?.closest<SVGElement>(".nt-edge") ?? null,
        scene.querySelector<HTMLElement>(`[data-edge-label="${key}"]`),
      ];
    }),
  ]
    .map((els) => els.filter((el): el is HTMLElement | SVGElement => !!el))
    .filter((els) => els.length > 0);
  const delays = arrivalDelays(pieces.length);
  const settles = new Map<Element, () => void>();
  const settle = (el: Element) => {
    settles.get(el)?.();
    settles.delete(el);
  };
  const mark = (el: HTMLElement | SVGElement, name: string, prop: string, value: string) => {
    const done = (event: Event) => {
      if (event.target === el) settle(el);
    };
    el.style.setProperty(prop, value);
    el.setAttribute(name, "");
    el.addEventListener("animationend", done);
    settles.set(el, () => {
      el.removeEventListener("animationend", done);
      el.removeAttribute(name);
      el.style.removeProperty(prop);
    });
  };

  const opening = bandGlide(band);
  if (opening) {
    const open = () => band.removeAttribute("data-opening");
    band.setAttribute("data-opening", "");
    opening.finished.then(open, open);
  }
  pieces.forEach((els, i) => els.forEach((el) => mark(el, "data-arriving", "--nt-arrive-delay", `${delays[i]}ms`)));
  // An entrance that never ends — the band scrolled out of a painting pane,
  // the element redrawn — still lets go.
  const last = delays.at(-1) ?? 0;
  setTimeout(() => [...settles.keys()].forEach(settle), last + ARRIVE_MS + 120);
}
