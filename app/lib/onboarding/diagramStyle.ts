/**
 * The look the scripted diagrams are drawn in.
 *
 * Lifted verbatim from the few-shot examples in `lib/ai/diagram.ts`, which took
 * them from `render/newShape.ts` in the first place. The point of copying
 * rather than inventing is that a diagram the guide draws and a diagram the
 * model draws have to be the same object — if the tour's one looked different,
 * the first real diagram a user asks for would read as a downgrade.
 *
 * Written `prop: value` with a space, the canonical form `serializeStyleAttr`
 * emits, so a scripted diagram survives the round trip untouched.
 */

export const BOX =
  "background: #f2f2f0; border: 1px solid #d8d8d4; border-radius: 10px; " +
  "display: flex; align-items: center; justify-content: center; " +
  "text-align: center; color: #2b2b28; font-size: 13px";

/** The same box without a corner radius, for kinds that draw their own. */
export const PLAIN = BOX.replace("border-radius: 10px; ", "");

/** A softer box, for things that are context rather than the subject. */
export const GHOST_BOX =
  "background: #ffffff; border: 1px solid #e4e4e0; border-radius: 10px; " +
  "display: flex; align-items: center; justify-content: center; " +
  "text-align: center; color: #6b6b66; font-size: 13px";

export const CELL =
  "background: #ffffff; display: flex; align-items: center; " +
  "justify-content: center; color: #2b2b28; font-size: 12px";

export const HEAD = `${CELL}; font-weight: 600`;

/** A column heading above a group — words that belong to no shape. */
export const CAPTION =
  "display: flex; align-items: center; color: #6b6b66; font-size: 12px; font-weight: 600";

/** The wrapper a set of evenly-spaced cards sits in. */
export const COLUMN =
  "display: flex; flex-direction: column; gap: 8px; padding: 10px; " +
  "background: #fafaf9; border: 1px solid #e4e4e0; border-radius: 10px";
