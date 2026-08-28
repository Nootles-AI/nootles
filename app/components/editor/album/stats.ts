/**
 * What a picture looks like, in numbers, for free.
 *
 * This is the cheapest tier of what the agent knows about an album, and the
 * only one that costs nothing at all: it runs on the canvas `upload.ts` has
 * already drawn the photo into for the WebP re-encode, on a 48×48 downsample,
 * in well under a millisecond. No model, no key, no network — which is what
 * makes it safe to run on every upload rather than lazily.
 *
 * It answers more than it looks like it should. "Remove the outliers and get a
 * clean monochromatic look" is a question about hue spread and saturation, and
 * is fully decided here; the agent reads the numbers and names the pictures,
 * and not one image is ever sent to a model. That is the whole reason this tier
 * exists ahead of the captioning one.
 *
 * `energy` is the honest name for what a photograph looks like from across the
 * room: colourful and high-contrast reads as striking, flat and grey does not.
 * It is not taste and is not called an aesthetic score, because it is neither —
 * but it ranks a moodboard's hero shots correctly far more often than the
 * captions do, and it is free.
 */

export type ImageStats = {
  /** The single colour that best stands for the picture. */
  hex: string;
  /** Up to three, most-present first. The "extract its palette" answer. */
  palette: string[];
  /** 0–359, the saturation-weighted circular mean — grey pixels get no vote. */
  hue: number;
  /** 0–100, both means over every pixel. */
  sat: number;
  light: number;
  /** 0–99. Colourfulness and contrast, blended. */
  energy: number;
};

/** Wide enough to be representative, small enough that the read is instant. */
const GRID = 48;

/** Hasler–Süsstrunk saturates around here for photographs. */
const COLOURFUL_FULL = 110;
/** Luminance standard deviation of a punchy photograph. */
const CONTRAST_FULL = 70;

/**
 * Colour buckets per channel when looking for the dominant colours. Four bits
 * would separate shades nobody would call different; three groups a photograph
 * into the handful of colours a person would actually name.
 */
const BINS = 8;

export function statsFrom(source: CanvasImageSource): ImageStats | null {
  const canvas = document.createElement("canvas");
  canvas.width = GRID;
  canvas.height = GRID;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, GRID, GRID);

  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, GRID, GRID).data;
  } catch {
    // A canvas tainted by a cross-origin picture. Nothing is readable off it,
    // and refusing is the only correct answer — the alternative is stats for a
    // photograph we never actually saw.
    return null;
  }

  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let hueX = 0;
  let hueY = 0;
  let satTotal = 0;
  let lightTotal = 0;
  let rgSum = 0;
  let rgSquares = 0;
  let ybSum = 0;
  let ybSquares = 0;
  let lumaSum = 0;
  let lumaSquares = 0;
  let counted = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    // A transparent pixel is not a colour the picture has; a PNG cut-out is
    // mostly nothing, and averaging its nothing in would call it dark.
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    counted++;

    const key =
      ((r * BINS) >> 8) * BINS * BINS + ((g * BINS) >> 8) * BINS + ((b * BINS) >> 8);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);

    const { h, s, l } = toHsl(r, g, b);
    // Weighted by saturation: the hue of a grey pixel is arbitrary, and a
    // thousand arbitrary hues would drown out the few that are the picture.
    const radians = (h * Math.PI) / 180;
    hueX += Math.cos(radians) * s;
    hueY += Math.sin(radians) * s;
    satTotal += s;
    lightTotal += l;

    const rg = r - g;
    const yb = (r + g) / 2 - b;
    rgSum += rg;
    rgSquares += rg * rg;
    ybSum += yb;
    ybSquares += yb * yb;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma;
    lumaSquares += luma * luma;
  }

  if (!counted) return null;

  const palette = [...bins.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 3)
    .map(([, bin]) => hex(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n));

  const colourful =
    Math.sqrt(spread(rgSquares, rgSum, counted) + spread(ybSquares, ybSum, counted)) +
    0.3 * Math.sqrt((rgSum / counted) ** 2 + (ybSum / counted) ** 2);
  const contrast = Math.sqrt(spread(lumaSquares, lumaSum, counted));

  return {
    hex: palette[0],
    palette,
    hue: Math.round(((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360),
    sat: Math.round(satTotal / counted),
    light: Math.round(lightTotal / counted),
    energy: Math.min(
      99,
      Math.round(
        100 *
          (0.6 * Math.min(1, colourful / COLOURFUL_FULL) +
            0.4 * Math.min(1, contrast / CONTRAST_FULL)),
      ),
    ),
  };
}

/** Variance from running sums, floored at zero against rounding drift. */
function spread(squares: number, sum: number, n: number): number {
  return Math.max(0, squares / n - (sum / n) ** 2);
}

function toHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: (l / 255) * 100 };
  const d = max - min;
  const s = d / (l > 127.5 ? 510 - max - min : max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return { h, s: s * 100, l: (l / 255) * 100 };
}

function hex(r: number, g: number, b: number): string {
  const pair = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * An album's colour in words, from its pictures' stats.
 *
 * The one line the compact projection carries, so the agent can tell from the
 * page outline alone whether an album is worth expanding — "23 photos, mostly
 * warm neutrals" is enough to answer some questions outright and enough to
 * decide the rest.
 */
export function describeVibe(stats: readonly ImageStats[]): string | null {
  if (!stats.length) return null;
  const sat = stats.reduce((sum, s) => sum + s.sat, 0) / stats.length;
  const light = stats.reduce((sum, s) => sum + s.light, 0) / stats.length;

  if (sat < 12) return light > 55 ? "near-monochrome, light" : "near-monochrome, dark";

  // Circular again, and for the same reason: reds sit either side of zero, and
  // an arithmetic mean of 350° and 10° is cyan.
  const x = stats.reduce((sum, s) => sum + Math.cos((s.hue * Math.PI) / 180) * s.sat, 0);
  const y = stats.reduce((sum, s) => sum + Math.sin((s.hue * Math.PI) / 180) * s.sat, 0);
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  // How much the hues agree: near 1 they point one way, near 0 they scatter.
  const agreement = Math.hypot(x, y) / stats.reduce((sum, s) => sum + s.sat, 0);

  const family =
    hue < 20 || hue >= 330
      ? "red"
      : hue < 45
        ? "orange"
        : hue < 70
          ? "yellow"
          : hue < 165
            ? "green"
            : hue < 200
              ? "teal"
              : hue < 255
                ? "blue"
                : hue < 290
                  ? "violet"
                  : "pink";
  const weight = sat < 30 ? `muted ${family}` : sat > 60 ? `vivid ${family}` : family;
  return agreement > 0.55 ? `mostly ${weight}` : `mixed, leaning ${weight}`;
}
