import { describe, expect, it } from "vitest";
import { inSrgbGamut, oklchToRgb, p3ToRgb, rgbToOklch, rgbToP3 } from "./colorSpaces";
import type { RGBA } from "./color";

const close = (a: number, b: number, eps = 1) => Math.abs(a - b) <= eps;

describe("oklch <-> rgb round trip", () => {
  const samples: RGBA[] = [
    { r: 0, g: 0, b: 0, a: 1 },
    { r: 255, g: 255, b: 255, a: 1 },
    { r: 128, g: 128, b: 128, a: 1 },
    { r: 255, g: 0, b: 0, a: 1 },
    { r: 0, g: 255, b: 0, a: 1 },
    { r: 0, g: 0, b: 255, a: 1 },
    { r: 99, g: 102, b: 241, a: 1 },
    { r: 30, g: 200, b: 180, a: 1 },
    { r: 10, g: 10, b: 200, a: 1 },
    { r: 220, g: 40, b: 90, a: 1 },
    { r: 5, g: 60, b: 5, a: 1 },
    { r: 250, g: 250, b: 10, a: 1 },
    { r: 60, g: 30, b: 90, a: 1 },
    { r: 200, g: 150, b: 100, a: 1 },
    { r: 15, g: 15, b: 15, a: 1 },
    { r: 240, g: 240, b: 240, a: 1 },
    { r: 90, g: 180, b: 220, a: 1 },
    { r: 180, g: 90, b: 220, a: 1 },
    { r: 220, g: 180, b: 90, a: 1 },
    { r: 44, g: 88, b: 132, a: 1 },
  ];

  it("round-trips within 1 unit (0..255) for 20 sampled colours", () => {
    for (const rgb of samples) {
      const { L, C, H } = rgbToOklch(rgb);
      const back = oklchToRgb(L, C, H);
      expect(close(back.r, rgb.r)).toBe(true);
      expect(close(back.g, rgb.g)).toBe(true);
      expect(close(back.b, rgb.b)).toBe(true);
    }
  });

  it("a grey has ~zero chroma", () => {
    const { C } = rgbToOklch({ r: 128, g: 128, b: 128, a: 1 });
    expect(C).toBeLessThan(1e-3);
  });
});

describe("display-P3 <-> sRGB", () => {
  it("P3 grey equals sRGB grey", () => {
    const rgb: RGBA = { r: 128, g: 128, b: 128, a: 1 };
    const p3 = rgbToP3(rgb);
    // Grey has equal channels in every gamut sharing sRGB's white point.
    expect(close(p3.r, p3.g, 0.01)).toBe(true);
    expect(close(p3.g, p3.b, 0.01)).toBe(true);
    const back = p3ToRgb(p3.r, p3.g, p3.b);
    expect(close(back.r, rgb.r)).toBe(true);
    expect(close(back.g, rgb.g)).toBe(true);
    expect(close(back.b, rgb.b)).toBe(true);
  });

  it("round-trips an in-gamut colour within 0.5 unit", () => {
    const rgb: RGBA = { r: 90, g: 140, b: 60, a: 1 };
    const p3 = rgbToP3(rgb);
    const back = p3ToRgb(p3.r, p3.g, p3.b);
    expect(close(back.r, rgb.r, 0.5)).toBe(true);
    expect(close(back.g, rgb.g, 0.5)).toBe(true);
    expect(close(back.b, rgb.b, 0.5)).toBe(true);
  });

  it("P3 red is outside the sRGB gamut", () => {
    const rgb = p3ToRgb(1, 0, 0);
    expect(inSrgbGamut(rgb)).toBe(false);
  });

  it("sRGB-native colours are always in gamut", () => {
    expect(inSrgbGamut({ r: 0, g: 0, b: 0 })).toBe(true);
    expect(inSrgbGamut({ r: 255, g: 255, b: 255 })).toBe(true);
    expect(inSrgbGamut({ r: 128, g: 64, b: 200 })).toBe(true);
  });
});
