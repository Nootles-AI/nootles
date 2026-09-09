import { describe, expect, it } from "vitest";

import { DRAWN_INK, paintsBox, pathPaint, shadowFilter } from "./svgShape";

const d = "M 0 0 L 10 0 L 10 10 Z";

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

describe("paintsBox", () => {
  it("is true only for a background, border or outline that paints", () => {
    expect(paintsBox({ background: "#fff" })).toBe(true);
    expect(paintsBox({ "border-top": "1px solid #000" })).toBe(true);
    expect(paintsBox({ background: "none", display: "flex", "box-shadow": "0 0 4px #000" })).toBe(false);
  });
});
