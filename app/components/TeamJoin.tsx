/**
 * A team, pictured joining: an empty workspace and six teammates arriving in
 * it one at a time, each the way their work goes. The navigator walks in and
 * holds up the plan; the designer drops in and flourishes a brush; the
 * developer walks in and hammers the first item home; the marketer's chair
 * springs up and it calls out through a megaphone; the analyst's board arrives
 * and it hops onto a stool to point out the chart as it draws; the support
 * rep walks in with a heart and a wave. Then all six hop together, the last
 * item ticks, and the loop begins again.
 *
 * Rigged and animated in Heron (`scripts/team-join-art/join.scene.ts`), which
 * compiles it to CSS keyframes inside the SVG, so this is a plain image:
 * nothing here re-renders to drive it. With motion reduced the SVG holds its
 * rest pose, which is the finished picture — everyone in place. Decorative,
 * and marked so: whatever it sits beside says what it is.
 */
export function TeamJoin() {
  return (
    <div className="nt-team" aria-hidden="true">
      {/* An animated SVG, which `next/image` would rasterise. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="nt-team-art" src="/team/join.svg" alt="" draggable={false} />
    </div>
  );
}
