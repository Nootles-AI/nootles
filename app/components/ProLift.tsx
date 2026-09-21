/**
 * Pro, pictured: a team of characters building one Nootles document together.
 * The turtle walks in writing the header, the bear slides down a rope with the
 * card the flowchart is missing and sets it in place, the elephant paints the
 * mockups, the alien hammers out the code — then it all fades and they build
 * it again.
 *
 * The choreography lives in the SVG's own stylesheet (`public/pro/team-doc.svg`),
 * so this is a plain image: nothing here re-renders to drive it, and it costs
 * the palette nothing until the row is shown. Decorative, and marked so: the
 * row it sits beside says what it is.
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
