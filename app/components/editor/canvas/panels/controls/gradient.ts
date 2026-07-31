/** The subset of CSS gradients the panel authors: a direction and a stop list.
 *  Reads more than it writes — `to right`, bare `rgb()` stops and missing
 *  positions all parse — but always writes the one canonical form. */

export type GradientStop = { color: string; pos: number };
export type Gradient = {
  kind: "linear" | "radial";
  /** Degrees, CSS convention: 0 points up. Ignored when radial. */
  angle: number;
  stops: GradientStop[];
};

export const DEFAULT_GRADIENT: Gradient = {
  kind: "linear",
  angle: 135,
  stops: [
    { color: "#6366f1", pos: 0 },
    { color: "#a855f7", pos: 1 },
  ],
};

const TO_ANGLE: Record<string, number> = {
  "to top": 0,
  "to right": 90,
  "to bottom": 180,
  "to left": 270,
};

/** A stop's colour always brings a bracket or a `#`; a radial's head — `circle`,
 *  `ellipse at center` — never does. */
const looksLikeColor = (src: string) => /^#|[(]/.test(src);

/** Split on commas that are not inside a `rgb(...)`. */
function splitTop(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(src.slice(start).trim());
  return out.filter(Boolean);
}

/** `#a855f7 40%` -> colour and position; the position may be absent. */
function parseStop(src: string): { color: string; pos: number | null } | null {
  const m = /\s+(-?[\d.]+)%$/.exec(src);
  if (m) return { color: src.slice(0, m.index).trim(), pos: parseFloat(m[1]) / 100 };
  // A percent the position did not claim — `hsl(210 40% 96%)` — belongs to the
  // colour; one outside its brackets is a stop this editor cannot author.
  return /%/.test(src.replace(/\([^()]*\)/g, "")) ? null : { color: src, pos: null };
}

export function parseGradient(css: string): Gradient | null {
  const m = /^(linear|radial)-gradient\(([\s\S]*)\)$/i.exec(css.trim());
  if (!m) return null;
  const kind = m[1].toLowerCase() as Gradient["kind"];
  const parts = splitTop(m[2]);
  if (!parts.length) return null;

  let angle = kind === "linear" ? 180 : 0;
  const head = parts[0].toLowerCase();
  const deg = /^(-?[\d.]+)deg$/.exec(head);
  if (deg) {
    angle = parseFloat(deg[1]);
    parts.shift();
  } else if (head.startsWith("to ")) {
    angle = TO_ANGLE[head] ?? 180;
    parts.shift();
  } else if (kind === "radial" && !looksLikeColor(parts[0])) {
    // `circle`, `ellipse at center`, a size — read and dropped; we re-emit `circle`.
    parts.shift();
  }

  const raw = parts.map(parseStop);
  const read = raw.filter((s) => s !== null);
  if (read.length !== raw.length || read.length < 2) return null;
  const stops = read.map((s, i) => ({
    color: s.color,
    pos: s.pos ?? i / (read.length - 1),
  }));
  return { kind, angle, stops };
}

export function formatGradient({ kind, angle, stops }: Gradient): string {
  const list = [...stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${s.color} ${Math.round(s.pos * 100)}%`)
    .join(", ");
  const head = kind === "linear" ? `${Math.round(angle)}deg` : "circle";
  return `${kind}-gradient(${head}, ${list})`;
}
