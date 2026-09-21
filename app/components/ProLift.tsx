/**
 * Pro, pictured: a team of characters building one Nootles document together.
 * The turtle walks in and writes the header word by word; the bear is lowered
 * on a rope with the card the flowchart is missing, swings out and sets it in
 * place, and climbs away; the elephant walks in and paints the mockups; the
 * alien marches in and hammers out the code a line a blow.
 *
 * The animation is built into the SVG by `scripts/pro-art/build.mjs` (rigged
 * limbs, eyes and antennae, keyframes on one clock), so this is a plain image:
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
