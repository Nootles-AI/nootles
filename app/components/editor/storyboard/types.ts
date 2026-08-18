/**
 * The storyboard: a container of shots, each of which owns a canvas.
 *
 * The first attempt built a board out of one scene — nested auto-layout groups
 * standing in for rows, panels and frames. Everything that was wrong with it
 * came from the same place: structure was pretending to be user content inside
 * a general-purpose canvas. Positions four levels down were *computed* by the
 * layout engine, so anything reading authored x/y drew in the wrong place; the
 * scaffolding was selectable and deletable because it was ordinary nodes; the
 * layers panel listed it because it was really there; and the caption could not
 * be typed into because it was a shape's label, not a field.
 *
 * So a shot owns a whole canvas of its own instead. Every one of those problems
 * stops being a rule to enforce and becomes a fact:
 *
 *  - A drawing cannot leave its shot, because there is nowhere else to draw.
 *  - Overlays and gestures use the same maths a plain diagram already gets
 *    right, at an origin of 0 0, with no computed ancestry above them.
 *  - The scaffolding is real DOM, not scene nodes, so nothing can select it,
 *    delete it, or list it in the layers panel.
 *  - The note is a text field, because it is text.
 *
 * And the grammar the AI is taught collapses to "a storyboard is a list of
 * shots; a shot is a diagram and a note" — the diagram being the same
 * `<nt-diagram>` it already writes, at its own origin, with no new coordinate
 * system and no scaffolding it must be careful not to touch.
 */

/**
 * Frame shapes, spoken the way filmmakers say them. `9:16` is the one portrait
 * frame — reels, shorts, TikTok — and earns its place the way the widescreen
 * ones do: it is a format people board for, not a rotation of one.
 */
export type Ratio = "16:9" | "2.39:1" | "1.85:1" | "4:3" | "1:1" | "9:16";

export const RATIOS: readonly { id: Ratio; k: number }[] = [
  { id: "16:9", k: 16 / 9 },
  { id: "2.39:1", k: 2.39 },
  { id: "1.85:1", k: 1.85 },
  { id: "4:3", k: 4 / 3 },
  { id: "1:1", k: 1 },
  { id: "9:16", k: 9 / 16 },
];

export const DEFAULT_RATIO: Ratio = "16:9";
export const DEFAULT_SHOTS = 3;

/**
 * The width every shot's canvas is authored at, whatever it is displayed at.
 *
 * Shots are rendered scaled to their column, so the stored coordinates have to
 * mean something independent of how wide the block happens to be — otherwise a
 * window resize would rewrite every drawing in the board. Fixing the authoring
 * width and deriving the height from the ratio also makes a ratio change a pure
 * re-crop: the drawing keeps its coordinates and the frame around it changes,
 * which is what changing format does to a shot in life.
 */
export const SHOT_W = 320;

export function ratioById(id: string | undefined): Ratio {
  return RATIOS.find((r) => r.id === id)?.id ?? DEFAULT_RATIO;
}

export function shotHeight(ratio: Ratio): number {
  const k = RATIOS.find((r) => r.id === ratio)?.k ?? RATIOS[0].k;
  return Math.round(SHOT_W / k);
}

/** One shot: a canvas of its own, and the words under it. */
export interface Shot {
  /**
   * The shot's canvas, as canvas HTML — the very string `CanvasSurface` takes
   * as its `source`. Held as text rather than a parsed scene so that a shot is
   * exactly what the canvas already knows how to be handed, and so this module
   * never becomes a second opinion about what a scene is.
   */
  scene: string;
  /** Plain text, newlines and all. It is handwriting on ruled lines. */
  note: string;
}

export interface Storyboard {
  ratio: Ratio;
  shots: Shot[];
  /**
   * The block's display width in px, set only by the width grip — absent means
   * "the document column", exactly as it does on an album. Presentation, not
   * content: shots keep their authored coordinates at any width, so this only
   * decides how many columns the board reflows into and at what scale.
   */
  w?: number;
  /**
   * A pinned column count, set only by the toolbar — the album's pin, on a
   * board. Absent means the width decides. Pinning is how you say how BIG the
   * shots are: the same width across fewer columns is bigger frames. A width
   * grip drag drops the pin, as the album's does — a block being resized
   * should re-column before your eyes.
   */
  cols?: number;
  /**
   * The block's own id, put on the root only when the AI layer needs the board
   * to be addressable. Absent in what the editor stores, so a board written by
   * hand does not acquire one.
   */
  id?: string;
}

export const STORYBOARD_TAG = "nt-storyboard";
export const SHOT_TAG = "nt-shot";
export const NOTE_TAG = "nt-note";

/** Tags accepted as the root, canonical first. Liberal in what we read. */
export const STORYBOARD_TAGS: readonly string[] = [
  STORYBOARD_TAG,
  "storyboard",
  "nt-board",
];

export const SHOT_TAGS: readonly string[] = [SHOT_TAG, "shot", "nt-panel", "panel"];
export const NOTE_TAGS: readonly string[] = [NOTE_TAG, "note", "nt-caption", "caption"];

export function emptyStoryboard(
  shots = DEFAULT_SHOTS,
  ratio: Ratio = DEFAULT_RATIO,
): Storyboard {
  return {
    ratio,
    shots: Array.from({ length: shots }, () => ({ scene: "", note: "" })),
  };
}
