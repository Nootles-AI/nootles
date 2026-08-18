import { describe, expect, it } from "vitest";
import { packTurn, unpackTurn } from "./pack";

describe("packTurn", () => {
  it("round-trips a turn's luggage, much smaller", async () => {
    const turn = {
      pages: [
        {
          pageId: "p1",
          ops: [{ kind: "updateBlockProps", props: { data: "M 0 0 L 1 1 ".repeat(4000) } }],
        },
      ],
    };
    const packed = await packTurn(turn);
    expect(packed.byteLength).toBeLessThan(JSON.stringify(turn).length / 4);
    expect(await unpackTurn(packed)).toEqual(turn);
  });

  it("passes an unpacked legacy row through untouched", async () => {
    const legacy = { pages: [{ pageId: "p1" }] };
    expect(await unpackTurn(legacy)).toBe(legacy);
  });
});
