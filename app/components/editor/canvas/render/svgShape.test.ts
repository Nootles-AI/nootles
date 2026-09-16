import { describe, expect, it } from "vitest";

import type { PolygonNode, StyleMap } from "../scene/types";
import { DRAWN_INK, paintsBox, pathPaint, shadowFilter, shapeOf } from "./svgShape";

const d = "M 0 0 L 10 0 L 10 10 Z";

const diamond = (style: StyleMap): PolygonNode => ({
  id: "d1",
  kind: "polygon",
  sides: 4,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rot: 0,
  style,
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
});

describe("pathPaint", () => {
  it("keeps a gradient background as the fill, clipped to the geometry", () => {
    const { paint, drop } = pathPaint({ background: "linear-gradient(90deg, #000 0%, #fff 100%)" }, d);
    expect(paint).toEqual({ fill: "none", clipPath: `path("${d}")` });
    expect(drop("background")).toBe(false);
    expect(drop("border")).toBe(true);
  });

  it("inks a path that names neither fill nor stroke, and not one that says none to both", () => {
    expect(pathPaint({}, d).paint).toMatchObject({ fill: "none", stroke: DRAWN_INK });
    expect(pathPaint({ fill: "none", stroke: "none" }, d).paint).toEqual({});
  });
});

describe("shadowFilter", () => {
  it("casts each layer as a drop-shadow, after any filter already there, and leaves inset out", () => {
    expect(
      shadowFilter({
        "box-shadow": "0px 1.29px 5.18px 0px rgba(0, 0, 0, 0.22), inset 0 0 2px #000, 1px 1px 0 red",
        filter: "blur(2px)",
      }),
    ).toEqual({
      boxShadow: "none",
      filter: "blur(2px) drop-shadow(0px 1.29px 5.18px rgba(0, 0, 0, 0.22)) drop-shadow(1px 1px 0 red)",
    });
    expect(shadowFilter({})).toBeNull();
  });
});

describe("shapeOf", () => {
  it("leaves an SVG-painted diamond's box unclipped, ordinarily", () => {
    expect(shapeOf(diamond({ background: "#e8e8e6" }))?.clip).toBeNull();
  });

  it("clips a CSS-only fill (a gradient or picture) to the diamond, as before", () => {
    expect(shapeOf(diamond({ background: "linear-gradient(90deg, #000, #fff)" }))?.clip).not.toBeNull();
  });

  it("clips the box to the diamond when a backdrop-filter is set, even with a plain SVG fill", () => {
    // Without the clip, `backdrop-filter` samples what is behind the box's
    // full rectangular border box — the blur would read as a square behind
    // the diamond's corners rather than following its outline.
    expect(shapeOf(diamond({ background: "#e8e8e6", "backdrop-filter": "blur(8px)" }))?.clip).not.toBeNull();
  });

  it("does not clip for an explicit backdrop-filter: none", () => {
    expect(shapeOf(diamond({ background: "#e8e8e6", "backdrop-filter": "none" }))?.clip).toBeNull();
  });
});

describe("paintsBox", () => {
  it("is true only for a background, border or outline that paints", () => {
    expect(paintsBox({ background: "#fff" })).toBe(true);
    expect(paintsBox({ "border-top": "1px solid #000" })).toBe(true);
    expect(paintsBox({ background: "none", display: "flex", "box-shadow": "0 0 4px #000" })).toBe(false);
  });
});
