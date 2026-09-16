/** Colour maths for the picker.
 *
 *  Reads every form a document is likely to hold — hex, `rgb()`, `hsl()`,
 *  `oklch()`, `oklab()`, `color(display-p3 …)`, `color(srgb …)` — because the
 *  panel has to *show* a colour it did not write. `readColor`/`writeColor`
 *  (COLOR, added for wide-gamut preservation) remember which of those a value
 *  was authored in and write an edit back in the same one, so scrubbing a
 *  P3 fill's opacity does not silently flatten it to sRGB hex; the plain
 *  `parseColor`/`formatColor` pair below still exists for every caller that
 *  only ever wants "the colour, roughly, as a swatch" — the picker's HSV
 *  square, comparisons, anything that doesn't touch the document's own bytes.
 *
 *  OKLab/OKLCh and Display-P3 maths live in `colorSpaces.ts`, not here — this
 *  module reads and writes CSS strings; that one knows what a wide-gamut
 *  channel means. */

import {
  inSrgbGamut,
  oklabToRgb,
  oklchToRgb,
  p3ToRgb,
  rgbToOklch,
  rgbToP3,
} from "./colorSpaces";

export type RGBA = { r: number; g: number; b: number; a: number };
export type HSV = { h: number; s: number; v: number };

export const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const clamp255 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n);

/** `50%` → 0.5, `.5` → 0.5, `none` → 0. */
function ratio(p: string): number {
  if (p === "none") return 0;
  const n = parseFloat(p);
  if (!Number.isFinite(n)) return NaN;
  return p.endsWith("%") ? n / 100 : n;
}

function angle(p: string): number {
  const n = parseFloat(p);
  if (!Number.isFinite(n)) return 0;
  if (p.endsWith("turn")) return n * 360;
  if (p.endsWith("rad")) return (n * 180) / Math.PI;
  if (p.endsWith("grad")) return n * 0.9;
  return n;
}

/** Both call syntaxes at once: `f(a, b, c, α)` and `f(a b c / α)`. */
function splitArgs(src: string): { parts: string[]; a: number } {
  const slash = src.indexOf("/");
  const head = slash < 0 ? src : src.slice(0, slash);
  const parts = head.split(/[\s,]+/).filter(Boolean);
  const tail = slash < 0 ? parts[3] : src.slice(slash + 1).trim();
  return { parts, a: tail === undefined ? 1 : clamp01(ratio(tail)) };
}

/** The syntax family a value was authored in. Drives what an edit writes back. */
export type ColorForm = "hex" | "rgb" | "hsl" | "oklch" | "oklab" | "display-p3" | "srgb" | "other";

/** Unclamped: the raw channels a wide-gamut function produced, before sRGB
 *  clamps them for a swatch to paint. `readColor` needs these to tell a
 *  genuinely wide-gamut colour from one that only looks like one. */
interface RawColor {
  rgb: Omit<RGBA, "a">;
  a: number;
  form: ColorForm;
}

function parseRaw(css: string): RawColor | null {
  const s = css.trim();
  if (s === "transparent") return { rgb: { r: 0, g: 0, b: 0 }, a: 0, form: "other" };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    const short = h.length === 3 || h.length === 4;
    if (!short && h.length !== 6 && h.length !== 8) return null;
    const at = (i: number) =>
      parseInt(short ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16);
    const hasAlpha = h.length === 4 || h.length === 8;
    return { rgb: { r: at(0), g: at(1), b: at(2) }, a: hasAlpha ? at(3) / 255 : 1, form: "hex" };
  }

  const fn = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(s);
  if (!fn) return null;
  const kind = fn[1].toLowerCase();

  // `color()` is always the modern space syntax — colour-space name, then
  // three channels, never comma-separated — so it gets its own arg reader
  // rather than `splitArgs`'s rgb/hsl-shaped "a bare 4th number is alpha"
  // convention, which would mistake its *third channel* for an alpha.
  if (kind === "color") return parseColorFunction(fn[2]);

  const { parts, a } = splitArgs(fn[2]);
  if (parts.length < 3 || !Number.isFinite(a)) return null;

  let rgb: Omit<RGBA, "a"> | null = null;
  let form: ColorForm = "other";
  if (kind === "rgb" || kind === "rgba") {
    const chan = (p: string) => (p.endsWith("%") ? ratio(p) * 255 : ratio(p));
    rgb = { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]) };
    form = "rgb";
  } else if (kind === "hsl" || kind === "hsla") {
    rgb = hslToRgb(angle(parts[0]), ratio(parts[1]), ratio(parts[2]));
    form = "hsl";
  } else if (kind === "oklch") {
    // Chroma's percentage reference is 0.4, unlike lightness's 1.
    const c = parts[1].endsWith("%") ? ratio(parts[1]) * 0.4 : ratio(parts[1]);
    rgb = oklchToRgb(ratio(parts[0]), c, angle(parts[2]));
    form = "oklch";
  } else if (kind === "oklab") {
    // `a`/`b` reference 0.4 for a percentage, exactly like oklch's chroma.
    const chan = (p: string) => (p.endsWith("%") ? ratio(p) * 0.4 : ratio(p));
    rgb = oklabToRgb(ratio(parts[0]), chan(parts[1]), chan(parts[2]));
    form = "oklab";
  }
  // Anything else (`var`, `calc`, an unrecognised function) is left
  // unhandled: `rgb` stays null and the value round-trips as authored.
  if (!rgb || [rgb.r, rgb.g, rgb.b].some((n) => !Number.isFinite(n))) return null;
  return { rgb, a, form };
}

/** `color(<space> c1 c2 c3 [/ alpha])` — its own reader (see the call site's
 *  comment above for why it cannot share `splitArgs`). Only `display-p3` and
 *  `srgb` are understood; any other space (`rec2020`, `xyz`, …) returns
 *  `null` so the value round-trips as authored, same as today. */
function parseColorFunction(body: string): RawColor | null {
  const slashAt = body.indexOf("/");
  const head = (slashAt < 0 ? body : body.slice(0, slashAt)).trim();
  const alphaStr = slashAt < 0 ? undefined : body.slice(slashAt + 1).trim();
  const a = alphaStr === undefined ? 1 : clamp01(ratio(alphaStr));
  if (!Number.isFinite(a)) return null;

  const parts = head.split(/\s+/).filter(Boolean);
  if (parts.length < 4) return null;
  const space = parts[0].toLowerCase();
  // color() channels are 0..1 or a percentage of it — `ratio` already does
  // the /100, so no extra scale factor belongs here (unlike oklch/oklab's
  // chroma/a/b, whose percentage reference is 0.4, not 1).
  let rgb: Omit<RGBA, "a"> | null = null;
  let form: ColorForm = "other";
  if (space === "display-p3") {
    rgb = p3ToRgb(ratio(parts[1]), ratio(parts[2]), ratio(parts[3]));
    form = "display-p3";
  } else if (space === "srgb") {
    rgb = { r: ratio(parts[1]) * 255, g: ratio(parts[2]) * 255, b: ratio(parts[3]) * 255 };
    form = "srgb";
  }
  if (!rgb || [rgb.r, rgb.g, rgb.b].some((n) => !Number.isFinite(n))) return null;
  return { rgb, a, form };
}

export function parseColor(css: string): RGBA | null {
  const raw = parseRaw(css);
  if (!raw) return null;
  return { r: clamp255(raw.rgb.r), g: clamp255(raw.rgb.g), b: clamp255(raw.rgb.b), a: raw.a };
}

export interface ColorRead {
  rgba: RGBA; // sRGB, clamped 0..255 (what swatches paint)
  form: ColorForm;
  /** Channels had to be clamped to reach sRGB — a wide-gamut colour. */
  outOfGamut: boolean;
}

/** `parseColor` plus provenance: which syntax family the value was authored
 *  in, and whether it actually needed sRGB's gamut to be clamped away. */
export function readColor(css: string): ColorRead | null {
  const raw = parseRaw(css);
  if (!raw) return null;
  const rgba = { r: clamp255(raw.rgb.r), g: clamp255(raw.rgb.g), b: clamp255(raw.rgb.b), a: raw.a };
  const wide = raw.form === "oklch" || raw.form === "oklab" || raw.form === "display-p3";
  return { rgba, form: raw.form, outOfGamut: wide && !inSrgbGamut(raw.rgb) };
}

/** The text field is forgiving: a bare `abc` or `d4d4d8` is a hex. */
export function parseColorText(text: string): RGBA | null {
  const s = text.trim();
  return parseColor(/^[0-9a-f]{3,8}$/i.test(s) ? `#${s}` : s);
}

export function formatColor({ r, g, b, a }: RGBA): string {
  if (a >= 1) return toHex({ r, g, b, a });
  const round = (n: number) => Math.round(clamp255(n));
  return `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${Math.round(a * 100) / 100})`;
}

/** Six digits, no alpha: the code a designer types and reads. */
export function toHex({ r, g, b }: RGBA): string {
  const h = (n: number) =>
    Math.round(clamp255(n)).toString(16).padStart(2, "0").toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** How a colour reads in the sidebar: hex, and a percent when it is not
 *  opaque. Unparseable values show as authored rather than as a lie. */
export function displayColor(css: string): string {
  const rgba = parseColor(css);
  if (!rgba) return css.trim();
  const pct = Math.round(rgba.a * 100);
  return pct >= 100 ? toHex(rgba) : `${toHex(rgba)} ${pct}%`;
}

export function rgbToHsv({ r, g, b }: RGBA): HSV {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

export function hsvToRgb(h: number, s: number, v: number): Omit<RGBA, "a"> {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][seg];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function hslToRgb(h: number, s: number, l: number): Omit<RGBA, "a"> {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb(((h % 360) + 360) % 360, v === 0 ? 0 : 2 * (1 - l / v), v);
}

// ---------------------------------------------------------------------------
// Wide-gamut preservation — writeColor / withAlpha / sameRgba
// ---------------------------------------------------------------------------

/** Equal to the eye: every channel within 0.5/255 and alpha within 0.005. */
export function sameRgba(a: RGBA, b: RGBA): boolean {
  return (
    Math.abs(a.r - b.r) <= 0.5 &&
    Math.abs(a.g - b.g) <= 0.5 &&
    Math.abs(a.b - b.b) <= 0.5 &&
    Math.abs(a.a - b.a) <= 0.005
  );
}

/** Every function name `withAlpha` knows how to perform alpha surgery on.
 *  Anything else — `var()` chief among them — is returned unchanged. */
const COLOR_FN_NAMES = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
]);

const round2 = (n: number) => Math.round(n * 100) / 100;
const alphaSuffix = (a: number, sep: string) => (a < 1 ? `${sep}${round2(a)}` : "");

/** First `/` not nested inside a `()` — the alpha separator of the modern
 *  space syntax. None of the forms this module writes ever nest parens
 *  inside a colour function, so a plain scan is exact. */
function topLevelSlash(body: string): number {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "/" && depth === 0) return i;
  }
  return -1;
}

function splitTopCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
}

/**
 * Only the alpha changed: rewrite the alpha slot and nothing else. Hex →
 * hex8 is NOT used, `rgba()` is (today's `FillSection.withAlpha` rule, now
 * living here). For `oklch()`/`oklab()`/`color()` the numeric tokens stay
 * byte-identical and only the `/ a` slot changes. `var()` and anything else
 * this module cannot parse a function name out of are returned unchanged.
 */
export function withAlpha(css: string, a: number): string {
  const s = css.trim();
  const clamped = clamp01(a);
  if (/^#/.test(s)) {
    const rgb = parseColor(s);
    return rgb ? formatColor({ ...rgb, a: clamped }) : s;
  }
  const fn = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(s);
  if (!fn) return s;
  const kind = fn[1].toLowerCase();
  // Only a colour function's own alpha slot is ours to touch — `var()`,
  // `calc()`, or anything else this module doesn't author is left byte-for-
  // byte alone, exactly like an unparseable value.
  if (!COLOR_FN_NAMES.has(kind)) return s;
  const body = fn[2];
  const legacyRgb = kind === "rgb" || kind === "rgba";
  const legacyHsl = kind === "hsl" || kind === "hsla";

  const slash = topLevelSlash(body);
  if (slash >= 0) {
    const head = body.slice(0, slash).replace(/\s+$/, "");
    return `${kind}(${head}${alphaSuffix(clamped, " / ")})`;
  }
  if (legacyRgb || legacyHsl) {
    const parts = splitTopCommas(body).map((p) => p.trim());
    const head = parts.slice(0, 3).join(", ");
    const base = legacyRgb ? "rgb" : "hsl";
    const withA = legacyRgb ? "rgba" : "hsla";
    return clamped >= 1 ? `${base}(${head})` : `${withA}(${head}, ${round2(clamped)})`;
  }
  // Modern space syntax with no existing alpha slot — append one.
  return `${kind}(${body.trim()}${alphaSuffix(clamped, " / ")})`;
}

/**
 * The string an edit writes, given the value the field showed (`prev`) and
 * the colour the picker now holds. `prev` may be unparseable (a `var()`, an
 * empty field) — then it writes hex/rgba exactly as before this slice.
 */
export function writeColor(prev: string, next: RGBA): string {
  const read = readColor(prev);
  if (!read) return formatColor(next);
  if (sameRgba(read.rgba, next)) return prev;
  const onlyAlphaDiffers =
    Math.abs(read.rgba.r - next.r) <= 0.5 &&
    Math.abs(read.rgba.g - next.g) <= 0.5 &&
    Math.abs(read.rgba.b - next.b) <= 0.5;
  if (onlyAlphaDiffers) return withAlpha(prev, next.a);

  switch (read.form) {
    case "oklch":
    case "oklab": {
      const { L, C, H } = rgbToOklch(next);
      // Grey has no hue of its own — keep the one the field was already
      // showing rather than letting a near-zero chroma jitter it to 0.
      const hue = C < 1e-4 ? rgbToOklch(read.rgba).H : H;
      return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${hue.toFixed(1)}${alphaSuffix(next.a, " / ")})`;
    }
    case "display-p3": {
      const { r, g, b } = rgbToP3(next);
      return `color(display-p3 ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}${alphaSuffix(next.a, " / ")})`;
    }
    case "srgb": {
      const r = next.r / 255;
      const g = next.g / 255;
      const b = next.b / 255;
      return `color(srgb ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}${alphaSuffix(next.a, " / ")})`;
    }
    default:
      return formatColor(next);
  }
}
