import { describe, expect, it } from "vitest";
import { newNode } from "../render/newShape";
import { BAND, bandFloor, bandHeight, WIDE_MARGIN } from "../scene/band";
import { emptyScene } from "../scene/migrate";
import { applyOps } from "../scene/ops";
import { landingIn, landOps, penPoint, pictureOps, placeNew, sceneFor, type BandBox, type BlockBox } from "./pageDraw";

// Client px: a band from 100 to 300 down, 200 to 920 across, drawn at 1×; and
// another under it, drawn at half size.
const bands: BandBox[] = [
  { blockId: "top", left: 200, right: 920, top: 100, bottom: 300, scale: 1 },
  { blockId: "low", left: 200, right: 920, top: 600, bottom: 700, scale: 0.5 },
];
const at = (x: number, y: number, w = 0, h = 0) => ({ box: { x, y, w, h }, origin: { x, y } });

describe("a draw begun outside every band", () => {
  it("within a band's room below one is that diagram's (B8)", () => {
    const { box, origin } = at(400, 320);
    expect(landingIn(bands, box, origin)).toEqual({ blockId: "top", how: "gap" });
  });

  it("and within it above one", () => {
    const { box, origin } = at(400, 90);
    expect(landingIn(bands, box, origin)).toEqual({ blockId: "top", how: "gap" });
  });

  it("measures that room in the band's own px, as it is drawn", () => {
    expect(landingIn(bands, at(400, 588).box, at(400, 588).origin)).toEqual({ blockId: "low", how: "gap" });
    expect(landingIn(bands, at(400, 580).box, at(400, 580).origin)).toBeNull();
  });

  it("goes to the nearer band when two are that close", () => {
    const close: BandBox[] = [
      { blockId: "a", left: 0, right: 720, top: 0, bottom: 100, scale: 1 },
      { blockId: "b", left: 0, right: 720, top: 130, bottom: 200, scale: 1 },
    ];
    expect(landingIn(close, at(10, 110).box, at(10, 110).origin)?.blockId).toBe("a");
    expect(landingIn(close, at(10, 122).box, at(10, 122).origin)?.blockId).toBe("b");
  });

  it("past that room, or out to the side of it, is nobody's", () => {
    expect(landingIn(bands, at(400, 300 + BAND + 1).box, at(400, 300 + BAND + 1).origin)).toBeNull();
    expect(landingIn(bands, at(150, 310).box, at(150, 310).origin)).toBeNull();
  });

  it("drawn wholly beside one, between its top and bottom, is that diagram's (B9)", () => {
    expect(landingIn(bands, { x: 940, y: 150, w: 100, h: 80 }, { x: 940, y: 150 })).toEqual({
      blockId: "top",
      how: "beside",
    });
    expect(landingIn(bands, { x: 120, y: 150, w: 60, h: 80 }, { x: 120, y: 150 })).toEqual({
      blockId: "top",
      how: "beside",
    });
  });

  it("but not reaching past its top or bottom", () => {
    expect(landingIn(bands, { x: 940, y: 250, w: 100, h: 80 }, { x: 940, y: 250 })).toBeNull();
  });
});

describe("where a new diagram goes", () => {
  const blocks: BlockBox[] = [
    { id: "p1", top: 0, bottom: 40 },
    { id: "empty", top: 40, bottom: 66 },
    { id: "p2", top: 66, bottom: 106 },
  ];
  const isEmpty = (id: string) => id === "empty";

  it("over a paragraph: before it from its top half, after it from its bottom (G1)", () => {
    expect(placeNew(blocks, 10, isEmpty)).toEqual({ ref: "p1", where: "before" });
    expect(placeNew(blocks, 30, isEmpty)).toEqual({ ref: "p1", where: "after" });
  });

  it("on an empty line: in its place (G2)", () => {
    expect(placeNew(blocks, 50, isEmpty)).toEqual({ ref: "empty", where: "replace" });
  });

  it("or, for a diagram that may yet be given up, just before it", () => {
    expect(placeNew(blocks, 50, isEmpty, { replace: false })).toEqual({ ref: "empty", where: "before" });
  });

  it("past the last block: after it, or in its place when it is an empty line", () => {
    expect(placeNew(blocks, 400, isEmpty)).toEqual({ ref: "p2", where: "after" });
    expect(placeNew([...blocks, { id: "empty", top: 106, bottom: 132 }], 400, isEmpty)).toEqual({
      ref: "empty",
      where: "replace",
    });
  });

  it("in a page with nothing on it: nowhere", () => {
    expect(placeNew([], 10, isEmpty)).toBeNull();
  });
});

describe("the diagram a draw on the page makes", () => {
  it("holds the shape a band below its top, where it was drawn across", () => {
    const { scene, nodeId } = sceneFor("rect", { x: 40, y: 500, w: 120, h: 60 });
    expect(scene.nodes).toHaveLength(1);
    expect(scene.nodes[0]).toMatchObject({ id: nodeId, x: 40, y: BAND, w: 120, h: 60 });
    expect(scene.h).toBe(0);
    expect(bandHeight(scene)).toBe(bandFloor(scene));
    expect(scene.wide).toBeUndefined();
  });

  it("moves a shape drawn past the text's left edge onto it, and is wide past its right", () => {
    expect(sceneFor("ellipse", { x: -30, y: 0, w: 100, h: 50 }).scene.nodes[0].x).toBe(0);
    expect(sceneFor("rect", { x: 680, y: 0, w: 100, h: 50 }).scene.wide).toBe(true);
  });
});

describe("a shape landed in a diagram already there", () => {
  const scene = { ...emptyScene(), h: 200 };
  const node = (x: number, y: number) => newNode("rect", "n", { x, y, w: 100, h: 60 });

  it("goes in where it was drawn", () => {
    expect(landOps(scene, node(40, 250))).toEqual([{ type: "insert", nodes: [node(40, 250)] }]);
  });

  it("turns the diagram wide past the column, and stays inside the wide band", () => {
    const ops = landOps(scene, node(800, 40));
    expect(ops[0]).toEqual({ type: "setDiagram", wide: true });
    const landed = applyOps(scene, ops);
    expect(landed.wide).toBe(true);
    expect(landed.nodes[0].x).toBe(800);
    const far = applyOps(scene, landOps(scene, node(-400, 40)));
    expect(far.nodes[0].x).toBe(-WIDE_MARGIN);
  });

  it("drawn above the band, comes in at its top", () => {
    expect(applyOps(scene, landOps(scene, node(40, -20))).nodes[0].y).toBe(0);
  });
});

describe("pictures dropped on a diagram", () => {
  it("come in at the drop, no wider than a picture is let in, one step apart", () => {
    const scene = { ...emptyScene(), h: 200 };
    const { ops, ids } = pictureOps(scene, { x: 300, y: 100 }, [
      { src: "data:image/png;base64,AAA", w: 960, h: 480 },
      { src: "data:image/png;base64,BBB", w: 100, h: 50 },
    ]);
    const landed = applyOps(scene, ops);
    expect(ids).toHaveLength(2);
    expect(landed.nodes[0]).toMatchObject({ kind: "image", x: 60, y: 0, w: 480, h: 240 });
    expect(landed.nodes[1]).toMatchObject({ kind: "image", x: 300 - 50 + BAND, y: 100 - 25 + BAND, w: 100, h: 50 });
  });
});

describe("penPoint", () => {
  const band = bands[0];
  // The band's scene at 1×, its origin on the band's top-left.
  const born = {
    toScene: (p: { x: number; y: number }) => ({ x: p.x - band.left, y: p.y - band.top }),
    toClient: (p: { x: number; y: number }) => ({ x: p.x + band.left, y: p.y + band.top }),
  };

  it("on a band made for the path, goes where it was pressed: above, below, in a margin", () => {
    expect(penPoint(band, { x: 400, y: 40 }, born)).toEqual({ x: 400, y: 40 });
    expect(penPoint(band, { x: 400, y: 500 }, born)).toEqual({ x: 400, y: 500 });
    expect(penPoint(band, { x: band.right + 100, y: 200 }, born)).toEqual({ x: band.right + 100, y: 200 });
    expect(penPoint(band, { x: band.left - 100, y: 200 }, born)).toEqual({ x: band.left - 100, y: 200 });
  });

  it("is brought in only past the wide band's margins", () => {
    expect(penPoint(band, { x: band.right + WIDE_MARGIN + 50, y: 200 }, born).x).toBe(band.right + WIDE_MARGIN);
    expect(penPoint(band, { x: band.left - WIDE_MARGIN - 50, y: 200 }, born).x).toBe(band.left - WIDE_MARGIN);
  });

  it("on any other diagram, is held in the band and a band in from its top, but may go below", () => {
    expect(penPoint(band, { x: 100, y: 40 }, null)).toEqual({ x: band.left + 1, y: band.top + BAND });
    expect(penPoint(band, { x: 2000, y: 200 }, null)).toEqual({ x: band.right - 1, y: 200 });
    expect(penPoint(band, { x: 400, y: 500 }, null)).toEqual({ x: 400, y: 500 });
  });
});
