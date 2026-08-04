/**
 * The look the scripted diagrams are drawn in.
 *
 * Two colour families and a neutral, all low-chroma, and each one MEANS
 * something: slate is the subject of the drawing, sage is where it ends up or
 * what the document is arguing for, and the neutral is context that was
 * already there. A diagram where every box is tinted is a diagram where the
 * tint says nothing.
 *
 * Deliberately cool, and deliberately NOT the app's amber — that one means the
 * model is working, and a shape wearing it would be making a claim about
 * itself that is not true.
 *
 * Structure and geometry still come from `lib/ai/diagram.ts`, whose few-shot
 * examples this shares its grammar with: `prop: value` with a space, which is
 * the canonical form `serializeStyleAttr` emits, so a scripted diagram
 * survives the round trip untouched.
 */

const CENTRE =
  "display: flex; align-items: center; justify-content: center; text-align: center";

/** The subject. Most shapes in most diagrams. */
export const BOX =
  `background: #eef1f7; border: 1px solid #cdd5e5; border-radius: 10px; ` +
  `${CENTRE}; color: #2f3546; font-size: 13px`;

/** The same box without a corner radius, for kinds that draw their own. */
export const PLAIN = BOX.replace("border-radius: 10px; ", "");

/**
 * Where it comes out, or the thing being proposed. One or two shapes at most —
 * this is the colour that is supposed to catch the eye, and it can only do
 * that while it is rare.
 */
export const ACCENT =
  `background: #e9f2ef; border: 1px solid #c6dad3; border-radius: 10px; ` +
  `${CENTRE}; color: #27403a; font-size: 13px`;

/** Context: things that already existed and are not what the page is about. */
export const GHOST_BOX =
  `background: #ffffff; border: 1px solid #e3e7ee; border-radius: 10px; ` +
  `${CENTRE}; color: #5f6675; font-size: 13px`;

export const CELL = `background: #ffffff; ${CENTRE}; color: #2f3546; font-size: 12px`;

export const HEAD =
  `background: #eef1f7; ${CENTRE}; color: #2f3546; font-size: 12px; font-weight: 600`;

/** The rule between grid cells — the grid's gap, showing through. */
export const GRID_LINE = "#d5dae5";

/** A heading above a group: words that belong to no shape. */
export const CAPTION =
  "display: flex; align-items: center; color: #5f6675; font-size: 12px; font-weight: 600";

/** The wrapper a set of evenly-spaced cards sits in. */
export const COLUMN =
  "display: flex; flex-direction: column; gap: 8px; padding: 10px; " +
  "background: #f8fafc; border: 1px solid #e3e7ee; border-radius: 10px";
