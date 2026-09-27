import { describe, expect, it } from "vitest";
import { COLUMN_WIDTH } from "@/app/lib/column";
import { WIDE_MARGIN, WIDE_W } from "./bandSpan";
import { bandHeight } from "./bandGeometry";
import { absorb, roomFor, roomOps } from "./bandRoom";
import { emptyScene } from "./migrate";
import { applyOps } from "./ops";
import { pathDataBounds } from "./path";
import type { PathNode, Scene } from "./types";

const band: Scene = emptyScene();

describe("roomFor", () => {
  it("asks nothing of a drawing inside the band, however low", () => {
    expect(roomFor(band, { x: 0, y: 0, w: COLUMN_WIDTH, h: 5000 })).toBeNull();
  });

  it("moves everything down by what reaches above the top", () => {
    expect(roomFor(band, { x: 100, y: -37, w: 50, h: 80 })).toEqual({ wide: false, dx: 0, dy: 37 });
  });

  it("turns wide for what reaches past the column, and moves nothing that then fits", () => {
    expect(roomFor(band, { x: 600, y: 10, w: 200, h: 20 })).toEqual({ wide: true, dx: 0, dy: 0 });
    expect(roomFor(band, { x: -60, y: 10, w: 20, h: 20 })).toEqual({ wide: true, dx: 0, dy: 0 });
  });

  it("brings in what reaches past even the wide band, by the least amount", () => {
    const room = roomFor({ wide: true }, { x: WIDE_W - WIDE_MARGIN - 10, y: 0, w: 40, h: 10 });
    expect(room).toEqual({ wide: false, dx: -30, dy: 0 });
  });

  it("lays what is wider than the wide band against its left edge", () => {
    const room = roomFor({ wide: true }, { x: -WIDE_MARGIN + 5, y: 0, w: WIDE_W + 100, h: 10 });
    expect(room?.dx).toBe(-5);
  });

  it("does both at once, above and to the side", () => {
    expect(roomFor(band, { x: 700, y: -5, w: 60, h: 10 })).toEqual({ wide: true, dx: 0, dy: 5 });
  });
});

describe("roomOps", () => {
  const curve = (d: string, x: number, y: number): PathNode => {
    const b = pathDataBounds(d)!;
    return {
      kind: "path",
      id: "p",
      x,
      y,
      w: b.w,
      h: b.h,
      rot: 0,
      style: {},
      label: "",
      locked: false,
      hidden: false,
      attrs: {},
      d,
    };
  };

  it("lands a curve that bulged above the top at the top, the rest of the drawing with it", () => {
    // Both anchors 20px down the band, a handle pulled up past its top: the
    // arch's box — the node's — starts above it.
    const path = curve("M 0 50 C 0 -50 200 -50 200 50", 40, -5);
    const other = { ...path, id: "q", x: 300, y: 200, d: "M 0 0 L 10 10", w: 10, h: 10 };
    const scene: Scene = { ...band, nodes: [path, other] };
    const room = roomFor(scene, { x: path.x, y: path.y, w: path.w, h: path.h })!;
    expect(room.dy).toBeGreaterThan(0);
    const next = applyOps(scene, roomOps(scene, room));
    const [p, q] = next.nodes;
    expect(p.y).toBeCloseTo(0, 9);
    expect(q.y - p.y).toBeCloseTo(other.y - path.y, 9);
    expect(next.wide).toBeUndefined();
  });

  it("turns the band wide in the same ops", () => {
    const scene: Scene = { ...band, nodes: [curve("M 0 0 C 100 0 100 50 0 50", 680, 10)] };
    const room = roomFor(scene, { x: 680, y: 10, w: 75, h: 50 })!;
    expect(applyOps(scene, roomOps(scene, room)).wide).toBe(true);
  });

  it("grows the band up by what it moved the drawing down, keeping the room under it", () => {
    const path = curve("M 0 0 L 100 0", 40, 20);
    const scene: Scene = { ...band, h: 300, nodes: [path] };
    const next = applyOps(scene, roomOps(scene, { wide: false, dx: 0, dy: 37 }));
    expect(next.nodes[0].y).toBe(57);
    expect(bandHeight(next)).toBe(337);
  });

  it("leaves the height alone for a move sideways", () => {
    const scene: Scene = { ...band, h: 300, nodes: [curve("M 0 0 L 100 0", 40, 20)] };
    expect(applyOps(scene, roomOps(scene, { wide: false, dx: -12, dy: 0 })).h).toBe(300);
  });
});

describe("absorb", () => {
  it("scrolls the whole of a move down when the page has the room", () => {
    expect(absorb({ dx: 0, dy: 40 }, 1.5, 1000)).toEqual({ scroll: 40, rest: { x: 0, y: 0 } });
  });

  it("scrolls what it can and leaves the rest to be seen moving", () => {
    expect(absorb({ dx: 0, dy: 40 }, 2, 30)).toEqual({ scroll: 15, rest: { x: 0, y: 25 } });
  });

  it("scrolls nothing at the end of the page, nor for a move up or sideways", () => {
    expect(absorb({ dx: 0, dy: 40 }, 1, 0)).toEqual({ scroll: 0, rest: { x: 0, y: 40 } });
    expect(absorb({ dx: 12, dy: 0 }, 1, 500)).toEqual({ scroll: 0, rest: { x: 12, y: 0 } });
    expect(absorb({ dx: 0, dy: -5 }, 1, 500)).toEqual({ scroll: 0, rest: { x: 0, y: -5 } });
  });
});
