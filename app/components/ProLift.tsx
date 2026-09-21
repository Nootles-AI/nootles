/**
 * Pro, pictured: a team of characters building one Nootles document together.
 * The turtle walks in and writes the header and the flowchart; the bear rides
 * a rope down with the card the flowchart is missing, lets it drop into place
 * and climbs away; the elephant walks in and paints the mockups; the alien
 * marches in and hammers out the code a line a blow.
 *
 * Rigged and animated in Heron (`scripts/pro-art/team.scene.ts`), which
 * compiles it to CSS keyframes inside the SVG, so this is a plain image:
 * nothing here re-renders to drive it. Decorative, and marked so: the row it
 * sits beside says what it is.
 */
export function ProLift() {
  return (
    <div className="nt-pro" aria-hidden="true">
      {/* An animated SVG, which `next/image` would rasterise. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="nt-pro-art" src="/pro/team-doc.svg" alt="" draggable={false} />
    </div>
  );
}
