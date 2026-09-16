/**
 * Colour-space maths beyond sRGB — OKLab/OKLCh and Display-P3 — split out of
 * `color.ts` so that module can stay "the thing that reads and writes a CSS
 * colour string" while this one is "the thing that knows what a wide-gamut
 * channel actually means".
 *
 * `oklchToRgb` moved here verbatim from `color.ts` (COLOR, build-plan §2.6) —
 * `color.ts`'s `parseColor` imports it back rather than keeping its own copy.
 * Every conversion here is unclamped: a colour outside sRGB comes back with a
 * channel below 0 or above 255, which is exactly how `readColor` (color.ts)
 * decides `outOfGamut`. Clamping only ever happens at the sRGB boundary.
 */

import type { RGBA } from "./color";

export type Lin = { r: number; g: number; b: number };

/** IEC 61966-2-1 sRGB transfer function, both directions. `c` and the result
 *  are both 0..1 — callers scale to 0..255 themselves. */
export function srgbToLinear(c: number): number {
  const abs = Math.abs(c);
  return abs <= 0.04045 ? c / 12.92 : Math.sign(c) * ((abs + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  const abs = Math.abs(c);
  return abs <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * abs ** (1 / 2.4) - 0.055);
}

// ---------------------------------------------------------------------------
// OKLab / OKLCh — Björn Ottosson's matrices
// ---------------------------------------------------------------------------

/** OKLCh → OKLab → LMS → linear sRGB → sRGB. Unclamped: a wide-gamut colour
 *  comes back with a channel outside [0, 255]. */
export function oklchToRgb(L: number, C: number, H: number): Omit<RGBA, "a"> {
  const rad = (H * Math.PI) / 180;
  return oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad));
}

export function oklabToRgb(L: number, a: number, b: number): Omit<RGBA, "a"> {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (c: number) => 255 * linearToSrgb(c);
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Linear sRGB → LMS → OKLab, the exact inverse of {@link oklabToRgb}'s first
 *  half. `rgb` is 0..255 sRGB (gamma-encoded), as every other reader here
 *  takes it. */
export function rgbToOklch(rgb: RGBA | Omit<RGBA, "a">): { L: number; C: number; H: number } {
  const lin = (c: number) => srgbToLinear(c / 255);
  const r = lin(rgb.r);
  const g = lin(rgb.g);
  const b = lin(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  const H = C < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { L, C, H };
}

// ---------------------------------------------------------------------------
// Display-P3 — CSS Color 4 sample matrices, via XYZ D65
// ---------------------------------------------------------------------------

function matmul(m: readonly [number, number, number][], v: readonly [number, number, number]): Lin {
  return {
    r: m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    g: m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    b: m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  };
}

const P3_TO_XYZ: [number, number, number][] = [
  [0.4865709486, 0.2656676932, 0.1982172852],
  [0.2289745641, 0.6917385218, 0.0792869141],
  [0, 0.0451133819, 1.0439443689],
];
const XYZ_TO_SRGB: [number, number, number][] = [
  [3.2409699419, -1.5373831776, -0.4986107603],
  [-0.9692436363, 1.8759675015, 0.0415550574],
  [0.0556300797, -0.2039769589, 1.0569715142],
];
const SRGB_TO_XYZ: [number, number, number][] = [
  [0.4123907993, 0.3575843394, 0.1804807884],
  [0.2126390059, 0.7151686788, 0.0721923154],
  [0.0193308187, 0.1191947798, 0.9505321522],
];
const XYZ_TO_P3: [number, number, number][] = [
  [2.4934969119, -0.9313836179, -0.4027107845],
  [-0.8294889696, 1.7626640603, 0.0236246858],
  [0.0358458302, -0.0761723893, 0.9568845240],
];

/** `r`/`g`/`b` linear-P3 0..1 (already gamma-decoded — P3 shares sRGB's
 *  transfer function) → sRGB 0..255, unclamped. */
export function p3ToRgb(r: number, g: number, b: number): Omit<RGBA, "a"> {
  const lin = { r: srgbToLinear(r), g: srgbToLinear(g), b: srgbToLinear(b) };
  const xyz = matmul(P3_TO_XYZ, [lin.r, lin.g, lin.b]);
  const out = matmul(XYZ_TO_SRGB, [xyz.r, xyz.g, xyz.b]);
  return {
    r: 255 * linearToSrgb(out.r),
    g: 255 * linearToSrgb(out.g),
    b: 255 * linearToSrgb(out.b),
  };
}

/** The inverse: sRGB 0..255 → linear-P3 0..1 (gamma-encoded, as `color()`
 *  writes it). */
export function rgbToP3(rgb: RGBA | Omit<RGBA, "a">): { r: number; g: number; b: number } {
  const lin = (c: number) => srgbToLinear(c / 255);
  const xyz = matmul(SRGB_TO_XYZ, [lin(rgb.r), lin(rgb.g), lin(rgb.b)]);
  const out = matmul(XYZ_TO_P3, [xyz.r, xyz.g, xyz.b]);
  return {
    r: linearToSrgb(out.r),
    g: linearToSrgb(out.g),
    b: linearToSrgb(out.b),
  };
}

/** Whether an sRGB triple (0..255, unclamped) is actually inside the sRGB
 *  gamut — the wide-gamut tag's whole reason to exist. */
export function inSrgbGamut(rgb: Omit<RGBA, "a">, eps = 0.5): boolean {
  return [rgb.r, rgb.g, rgb.b].every((c) => c >= -eps && c <= 255 + eps);
}
