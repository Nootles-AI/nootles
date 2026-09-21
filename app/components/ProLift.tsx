/**
 * Pro, pictured: a team of characters building one Nootles document together
 * — a turtle writing its header, a bear climbing in with a note, an elephant
 * painting the mockups, an alien hammering out the code.
 *
 * The animation lives inside the SVG's own stylesheet, so this is a plain
 * image: nothing here re-renders to drive it, and it costs the palette nothing
 * until the row is shown. Decorative, and marked so: the row it sits beside
 * says what it is.
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
