/** Colour maths for the picker.
 *
 *  Reads every form a document is likely to hold — hex, `rgb()`, `hsl()`,
 *  `oklch()` — because the panel has to *show* a colour it did not write.
 *  Writes only hex and `rgba()`. Anything it cannot read round-trips as its own
 *  string until you actually edit it. */

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

export function parseColor(css: string): RGBA | null {
  const s = css.trim();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    const h = hex[1];
    const short = h.length === 3 || h.length === 4;
    if (!short && h.length !== 6 && h.length !== 8) return null;
    const at = (i: number) =>
      parseInt(short ? h[i] + h[i] : h.slice(i * 2, i * 2 + 2), 16);
    const hasAlpha = h.length === 4 || h.length === 8;
    return { r: at(0), g: at(1), b: at(2), a: hasAlpha ? at(3) / 255 : 1 };
  }

  const fn = /^([a-z]+)\(([\s\S]*)\)$/i.exec(s);
  if (!fn) return null;
  const kind = fn[1].toLowerCase();
  const { parts, a } = splitArgs(fn[2]);
  if (parts.length < 3 || !Number.isFinite(a)) return null;

  let rgb: Omit<RGBA, "a"> | null = null;
  if (kind === "rgb" || kind === "rgba") {
    const chan = (p: string) => (p.endsWith("%") ? ratio(p) * 255 : ratio(p));
    rgb = { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]) };
  } else if (kind === "hsl" || kind === "hsla") {
    rgb = hslToRgb(angle(parts[0]), ratio(parts[1]), ratio(parts[2]));
  } else if (kind === "oklch") {
    // Chroma's percentage reference is 0.4, unlike lightness's 1.
    const c = parts[1].endsWith("%") ? ratio(parts[1]) * 0.4 : ratio(parts[1]);
    rgb = oklchToRgb(ratio(parts[0]), c, angle(parts[2]));
  }
  if (!rgb || [rgb.r, rgb.g, rgb.b].some((n) => !Number.isFinite(n))) return null;
  return { r: clamp255(rgb.r), g: clamp255(rgb.g), b: clamp255(rgb.b), a };
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

/** OKLCh → OKLab → LMS → linear sRGB → sRGB (Björn Ottosson's matrices). */
function oklchToRgb(L: number, C: number, H: number): Omit<RGBA, "a"> {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (c: number) =>
    255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}
