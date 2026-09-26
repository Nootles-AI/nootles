import { describe, expect, it } from "vitest";
import { shapeIdsIn } from "./reveal";

describe("shapeIdsIn", () => {
  it("lists shapes at any depth, never the root or an edge", () => {
    const html =
      `<nt-diagram id="b7" w="10" h="10">\n  <nt-group id="g1" x="0" y="0" w="5" h="5">\n` +
      `    <nt-rect id="r1" x="0" y="0" w="1" h="1"></nt-rect>\n  </nt-group>\n` +
      `  <nt-edge id="e1" from="r1" to="g1"></nt-edge>\n</nt-diagram>`;
    expect([...shapeIdsIn(html)]).toEqual(["g1", "r1"]);
  });
});
