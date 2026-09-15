import { describe, expect, it } from "vitest";
import {
  formatColor,
  parseColor,
  readColor,
  sameRgba,
  withAlpha,
  writeColor,
  type RGBA,
} from "./color";

describe("parseColor — wide-gamut additions", () => {
  it("color(display-p3 0.5 0.5 0.5) is grey, in gamut", () => {
    const rgb = parseColor("color(display-p3 0.5 0.5 0.5)")!;
    expect(rgb.a).toBe(1);
    expect(Math.abs(rgb.r - rgb.g)).toBeLessThan(1);
    expect(Math.abs(rgb.g - rgb.b)).toBeLessThan(1);
    expect(readColor("color(display-p3 0.5 0.5 0.5)")?.outOfGamut).toBe(false);
  });

  it("color(display-p3 1 0 0) clamps into sRGB and flags out of gamut", () => {
    const read = readColor("color(display-p3 1 0 0)")!;
    expect(read.form).toBe("display-p3");
    expect(read.outOfGamut).toBe(true);
    expect(read.rgba.r).toBe(255);
  });

  it("color(srgb 0.5 0.5 0.5) reads directly, always in gamut", () => {
    const read = readColor("color(srgb 0.5 0.5 0.5)")!;
    expect(read.form).toBe("srgb");
    expect(read.outOfGamut).toBe(false);
    expect(read.rgba).toMatchObject({ r: 127.5, g: 127.5, b: 127.5 });
  });

  it("oklab round-trips oklch on the same colour", () => {
    const a = parseColor("oklch(0.7 0.15 250)")!;
    const b = parseColor("oklab(0.7 -0.0513 -0.1409)")!;
    expect(Math.abs(a.r - b.r)).toBeLessThan(1.5);
    expect(Math.abs(a.g - b.g)).toBeLessThan(1.5);
    expect(Math.abs(a.b - b.b)).toBeLessThan(1.5);
  });

  it("color(rec2020 ...) is null — an unhandled colour() space round-trips as authored", () => {
    expect(parseColor("color(rec2020 1 0 0)")).toBeNull();
  });
});

describe("readColor form table", () => {
  const cases: [string, string][] = [
    ["#abc", "hex"],
    ["#aabbccdd", "hex"],
    ["rgb(1, 2, 3)", "rgb"],
    ["rgba(1, 2, 3, 0.5)", "rgb"],
    ["hsl(200 50% 50%)", "hsl"],
    ["oklch(0.7 0.15 250)", "oklch"],
    ["oklab(0.7 0.05 -0.1)", "oklab"],
    ["color(display-p3 1 0 0)", "display-p3"],
    ["color(srgb 0.5 0.5 0.5)", "srgb"],
  ];
  for (const [css, form] of cases) {
    it(`${css} reads as ${form}`, () => {
      expect(readColor(css)?.form).toBe(form);
    });
  }

  it("an unparseable value (var, empty) reads as null", () => {
    expect(readColor("var(--brand)")).toBeNull();
    expect(readColor("")).toBeNull();
  });
});

describe("writeColor", () => {
  it("an unchanged colour returns prev verbatim", () => {
    const prev = "oklch(0.7000 0.1500 250.0)";
    const next = parseColor(prev)!;
    expect(writeColor(prev, next)).toBe(prev);
  });

  it("alpha-only change on oklch keeps the tokens and only touches the alpha slot", () => {
    const next: RGBA = { ...parseColor("oklch(0.7 0.15 250)")!, a: 0.5 };
    expect(writeColor("oklch(0.7 0.15 250)", next)).toBe("oklch(0.7 0.15 250 / 0.5)");
  });

  it("alpha-only change on legacy rgb writes rgba(...)", () => {
    const next: RGBA = { r: 10, g: 20, b: 30, a: 0.4 };
    expect(writeColor("rgb(10, 20, 30)", next)).toBe("rgba(10, 20, 30, 0.4)");
  });

  it("a hue edit on oklch writes oklch", () => {
    const next = parseColor("oklch(0.7 0.15 10)")!;
    const out = writeColor("oklch(0.7 0.15 250)", next);
    expect(out.startsWith("oklch(")).toBe(true);
  });

  it("an edit on display-p3 writes color(display-p3 ...)", () => {
    const next = parseColor("color(display-p3 0.2 0.8 0.4)")!;
    const out = writeColor("color(display-p3 1 0 0)", next);
    expect(out.startsWith("color(display-p3 ")).toBe(true);
  });

  it("an edit on hex writes hex", () => {
    const next: RGBA = { r: 10, g: 20, b: 30, a: 1 };
    expect(writeColor("#abcdef", next)).toBe(formatColor(next));
  });

  it("an edit on hsl writes plain hex/rgba (writeColor has no hsl writer)", () => {
    const next: RGBA = { r: 10, g: 20, b: 30, a: 1 };
    expect(writeColor("hsl(200 50% 50%)", next)).toBe(formatColor(next));
  });

  it("an unparseable prev (var, empty) falls back to formatColor", () => {
    const next: RGBA = { r: 1, g: 2, b: 3, a: 1 };
    expect(writeColor("var(--brand)", next)).toBe(formatColor(next));
  });
});

describe("withAlpha", () => {
  it("leaves a var() reference unchanged", () => {
    expect(withAlpha("var(--brand)", 0.5)).toBe("var(--brand)");
  });

  it("removes the alpha slot entirely at a=1", () => {
    expect(withAlpha("oklch(0.7 0.15 250 / 0.5)", 1)).toBe("oklch(0.7 0.15 250)");
    expect(withAlpha("rgba(1, 2, 3, 0.5)", 1)).toBe("rgb(1, 2, 3)");
  });

  it("adds a slot to a modern function with none yet", () => {
    expect(withAlpha("oklch(0.7 0.15 250)", 0.4)).toBe("oklch(0.7 0.15 250 / 0.4)");
    expect(withAlpha("color(display-p3 1 0 0)", 0.25)).toBe("color(display-p3 1 0 0 / 0.25)");
  });

  it("keeps hex/rgba's existing today-shape", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withAlpha("#ff0000", 1)).toBe("#FF0000");
  });
});

describe("sameRgba", () => {
  it("is tolerant of sub-half-unit float drift and near-zero alpha drift", () => {
    expect(sameRgba({ r: 1, g: 2, b: 3, a: 1 }, { r: 1.4, g: 1.6, b: 3.4, a: 0.996 })).toBe(true);
  });

  it("is false past the tolerance", () => {
    expect(sameRgba({ r: 1, g: 2, b: 3, a: 1 }, { r: 3, g: 2, b: 3, a: 1 })).toBe(false);
    expect(sameRgba({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 3, a: 0.9 })).toBe(false);
  });
});
