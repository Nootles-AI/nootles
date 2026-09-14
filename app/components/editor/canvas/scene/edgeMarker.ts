/**
 * The arrowhead's numbers — shared by `render/EdgeLayer.tsx` and
 * `app/lib/ai/html/toHtml.ts` so a connector's head is one triangle, not two
 * that happen to agree today.
 *
 * `orient`, `markerUnits` and the `fill` a marker paints with are deliberately
 * NOT here: the live renderer inherits its stroke's own colour through SVG's
 * `context-stroke`, which is exactly the thing the compiled output cannot rely
 * on (missing in every Safari before 17.4 — a pasted export has to paint
 * everywhere), so the compiler mints one marker per distinct stroke colour and
 * writes `fill` as a literal. Marker ids are document-global for the same
 * reason on both sides, but for different needs: `EdgeLayer` needs exactly one
 * id per canvas block; the compiler needs one id per distinct stroke, prefixed
 * so two independently pasted fragments never collide (`toHtml.ts` §2.1).
 */
export const ARROW_MARKER = {
  viewBox: "0 0 10 10",
  refX: "9",
  refY: "5",
  markerWidth: "7",
  markerHeight: "7",
  /** The triangle itself, in the marker's own 10×10 space. */
  d: "M0 0.5 10 5 0 9.5Z",
} as const;
