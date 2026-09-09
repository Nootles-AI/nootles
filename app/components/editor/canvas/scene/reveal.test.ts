import { describe, expect, it } from "vitest";
import { revealBounds, shapeIdsIn } from "./reveal";

const seen = { x: 0, y: 0, w: 1000, h: 600 };

describe("revealBounds", () => {
  it("leaves the view alone when the target already shows", () => {
    expect(revealBounds({ x: 100, y: 100, w: 200, h: 100 }, seen)).toBeNull();
  });

  it("grows the view to take in something just off screen, keeping the context", () => {
    expect(revealBounds({ x: 900, y: 100, w: 400, h: 100 }, seen)).toEqual({ x: 0, y: 0, w: 1300, h: 600 });
  });

  it("recentres on something far away rather than shrinking everything to a thumbnail", () => {
    const far = { x: 4000, y: 3000, w: 400, h: 300 };
    expect(revealBounds(far, seen)).toEqual(far);
  });
});

describe("shapeIdsIn", () => {
  it("lists shapes at any depth, never the root or an edge", () => {
    const html =
      `<nt-diagram id="b7" w="10" h="10">\n  <nt-group id="g1" x="0" y="0" w="5" h="5">\n` +
      `    <nt-rect id="r1" x="0" y="0" w="1" h="1"></nt-rect>\n  </nt-group>\n` +
      `  <nt-edge id="e1" from="r1" to="g1"></nt-edge>\n</nt-diagram>`;
    expect([...shapeIdsIn(html)]).toEqual(["g1", "r1"]);
  });
});
