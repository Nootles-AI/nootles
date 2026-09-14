import { describe, expect, it } from "vitest";
import {
  convert,
  isBound,
  isFlat,
  opacityOf,
  readFill,
  readFills,
  toLayer,
  withOpacity,
  writeFills,
  type Fill,
} from "./fills";
import { parseLayers } from "./cssCatalog";
import { parseGradient } from "./controls/gradient";

const layerOf = (bg: string) => parseLayers("background", bg)[0];

describe("readFill", () => {
  it("reads a solid background-color layer", () => {
    expect(readFill(layerOf("#333"))).toMatchObject({ type: "solid", paint: "#333" });
  });

  it("reads a gradient background-image layer", () => {
    const fill = readFill(layerOf("linear-gradient(90deg, #000 0%, #fff 100%)"));
    expect(fill.type).toBe("linear");
  });

  it("reads a flat two-stop gradient back as the solid it stands for (isFlat)", () => {
    const fill = readFill(layerOf("linear-gradient(rgba(1,2,3,0.5), rgba(1,2,3,0.5))"));
    expect(fill).toMatchObject({ type: "solid", paint: "rgba(1,2,3,0.5)" });
    expect(isFlat(parseGradient("linear-gradient(#000, #000)")!)).toBe(true);
    expect(isFlat(parseGradient("linear-gradient(#000, #fff)")!)).toBe(false);
  });

  it("reads an image layer", () => {
    expect(readFill(layerOf('url("x.png")'))).toMatchObject({ type: "image" });
  });
});

describe("toLayer", () => {
  it("writes a bare background-color only on the last layer", () => {
    const fill: Fill = { type: "solid", paint: "#333", layer: { values: {} } };
    expect(toLayer(fill, true).values["background-color"]).toBe("#333");
    expect(toLayer(fill, true).values["background-image"]).toBeUndefined();
  });

  it("wraps a non-last solid as a flat two-stop gradient of itself", () => {
    const fill: Fill = { type: "solid", paint: "rgba(1,2,3,0)", layer: { values: {} } };
    const layer = toLayer(fill, false);
    expect(layer.values["background-color"]).toBeUndefined();
    expect(layer.values["background-image"]).toBe("linear-gradient(rgba(1,2,3,0), rgba(1,2,3,0))");
  });
});

describe("readFills / writeFills round trip", () => {
  it("round-trips a mixed solid + gradient stack", () => {
    const bg = "linear-gradient(90deg, #000 0%, #fff 100%), #333";
    const fills = readFills(bg);
    expect(fills.map((f) => f.type)).toEqual(["linear", "solid"]);
    expect(writeFills(fills)).toBe(bg);
  });

  it("writeFills of an empty list is undefined", () => {
    expect(writeFills([])).toBeUndefined();
  });
});

describe("opacityOf / withOpacity", () => {
  it("reads a solid's alpha", () => {
    expect(opacityOf({ type: "solid", paint: "rgba(1,2,3,0.4)", layer: { values: {} } })).toBeCloseTo(0.4);
  });

  it("is 1 for an image", () => {
    expect(opacityOf({ type: "image", paint: 'url("x")', layer: { values: {} } })).toBe(1);
  });

  it("withOpacity on a solid uses color.ts's withAlpha (rgba spelling)", () => {
    const fill: Fill = { type: "solid", paint: "#ff0000", layer: { values: {} } };
    expect(withOpacity(fill, 0.5).paint).toBe("rgba(255, 0, 0, 0.5)");
  });

  it("withOpacity on a gradient fades every stop", () => {
    const fill = readFill(layerOf("linear-gradient(90deg, #000 0%, #fff 100%)"));
    const faded = withOpacity(fill, 0);
    const g = parseGradient(faded.paint)!;
    expect(g.stops.every((s) => s.color.startsWith("rgba") && s.color.endsWith(", 0)"))).toBe(true);
  });
});

describe("isBound", () => {
  it("is true for a var() solid", () => {
    expect(isBound({ type: "solid", paint: "var(--brand)", layer: { values: {} } })).toBe(true);
    expect(isBound({ type: "solid", paint: "#fff", layer: { values: {} } })).toBe(false);
  });

  it("is true for a gradient with a var() stop", () => {
    const fill = readFill(layerOf("linear-gradient(90deg, var(--a) 0%, #fff 100%)"));
    expect(isBound(fill)).toBe(true);
  });
});

describe("convert", () => {
  it("solid -> linear seeds a two-stop fade from the solid's own colour", () => {
    const fill: Fill = { type: "solid", paint: "#123456", layer: { values: {} } };
    const g = convert(fill, "linear");
    expect(parseGradient(g.paint)?.stops[0].color).toBe("#123456");
  });

  it("gradient -> solid keeps the first stop's colour", () => {
    const fill = readFill(layerOf("linear-gradient(90deg, #abc123 0%, #fff 100%)"));
    expect(convert(fill, "solid").paint).toBe("#abc123");
  });
});
