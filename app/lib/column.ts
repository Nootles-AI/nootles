/**
 * The document column's width, in px — the one number every page, thumbnail and
 * AI layout agrees on. CSS reads it as `--measure`, which the root layout sets
 * from here, so there is no second copy to drift.
 *
 * Its floor is the canvas: a three-wide diagram needs 588px (2 × 220 spacing +
 * 148 shape). Code and diagrams share this width with prose — they do not break
 * out of it.
 */
export const COLUMN_WIDTH = 720;

/**
 * The document's body type — size in px and unitless line height. CSS reads
 * them as `--text-body` and `--leading-body`, set by the root layout from
 * here, and the diagram grammar quotes them so a model can match a diagram's
 * words to the text around it.
 */
export const BODY_PX = 15;
export const BODY_LEADING = 1.7;

/**
 * The measures above as the custom properties CSS reads them by. Every root
 * that renders the app's stylesheet sets these on its `<html>`, so CSS keeps
 * no copy of its own.
 */
export const COLUMN_VARS: Readonly<Record<string, string>> = {
  "--measure": `${COLUMN_WIDTH}px`,
  "--text-body": `${BODY_PX}px`,
  "--leading-body": String(BODY_LEADING),
};
