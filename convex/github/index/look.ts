import { serverSide } from "./cluster";
import type { ParsedFile } from "./parse";
import { isTest } from "./select";

/**
 * How a product looks, read off its code and said in CSS.
 *
 * The canvas draws in HTML and CSS, so every fact here is a CSS value: a
 * Tailwind `bg-blue-600` is `#2563eb`, a SwiftUI `.cornerRadius(12)` is
 * `12px`, a Compose `Color(0xFF6200EE)` is `#6200ee`. Declared tokens say what
 * a design system offers; this says what the screens actually use, and how
 * often — the palette a mockup has to reproduce.
 *
 * Scanned, not parsed, per platform, and deterministic: files are read in
 * path order and every list is sorted by use, then by value.
 */

export type Role = "background" | "text" | "border" | "accent";
export type Swatch = { css: string; name?: string; role?: Role; count: number };
export type Measure = { css: string; name?: string; count: number };
export type Look = {
  colours: Swatch[];
  radii: Measure[];
  shadows: Measure[];
  fonts: Measure[];
  type: Measure[];
  spacing: Measure[];
  components: string[];
  platforms: string[];
};

const PLATFORMS = [
  "tailwind", "css", "react-native", "swiftui", "uikit", "android-xml", "compose", "flutter", "tokens",
] as const;
type Platform = (typeof PLATFORMS)[number];

const MAX_RULES = 12;
const DECLS_SHOWN = 10;

export function readLook(files: ParsedFile[], texts: Map<string, string>): Look {
  const entries = [...texts]
    .filter(([path]) => !isTest(path))
    .sort(([a], [b]) => compare(a, b));
  const bag = newBag();
  const sheets = styleSources(entries);
  const tokens = tokenMap(files, sheets);
  const tailwind = tailwindContext(entries, tokens);

  readCss(sheets, tokens, tailwind, bag);
  if (tailwind) readTailwind(entries, tailwind, bag);
  readWebFonts(entries, bag);
  readReactNative(entries, bag);
  readThemeObjects(entries, bag);
  readTokenFiles(entries, bag);
  readApple(entries, bag);
  readAndroid(entries, bag);
  readFlutter(entries, bag);

  return {
    colours: bag.colours.list(),
    radii: bag.radii.list(),
    shadows: bag.shadows.list(),
    fonts: bag.fonts.list(),
    type: bag.type.list(),
    spacing: bag.spacing.list(),
    // A rule that sets a control's whole look — fill, border, corners, padding —
    // says more than a common one that sets only its padding, so richness
    // outranks frequency once the kind of control is the same.
    components: [...bag.rules]
      .sort(
        (a, b) =>
          a[1].rank - b[1].rank ||
          b[1].fit - a[1].fit ||
          richness(b[0]) - richness(a[0]) ||
          b[1].count - a[1].count ||
          a[1].at - b[1].at,
      )
      .slice(0, MAX_RULES)
      .map(([rule]) => rule),
    platforms: PLATFORMS.filter((p) => bag.platforms.has(p)),
  };
}

// ---------------------------------------------------------------- tallies

type Entry = {
  count: number;
  names: Map<string, number>;
  roles: Map<Role, number>;
  /** Names by the role they were used in, so the name shown fits the role shown. */
  named: Map<Role, Map<string, number>>;
};

class Tally {
  private entries = new Map<string, Entry>();

  add(css: string | null | undefined, name?: string, role?: Role, n = 1) {
    if (!css) return;
    let e = this.entries.get(css);
    if (!e) {
      e = { count: 0, names: new Map(), roles: new Map(), named: new Map() };
      this.entries.set(css, e);
    }
    e.count += n;
    if (name) e.names.set(name, (e.names.get(name) ?? 0) + n);
    if (role) e.roles.set(role, (e.roles.get(role) ?? 0) + n);
    if (name && role) {
      const names = e.named.get(role) ?? new Map<string, number>();
      names.set(name, (names.get(name) ?? 0) + n);
      e.named.set(role, names);
    }
  }

  list(): Swatch[] {
    return [...this.entries]
      .map(([css, e]) => {
        const out: Swatch = { css, count: e.count };
        const role = most(e.roles);
        const name = most((role && e.named.get(role)) || e.names);
        if (name) out.name = name;
        if (role) out.role = role;
        return out;
      })
      .sort((a, b) => b.count - a.count || compare(a.css, b.css));
  }
}

function most<K extends string>(m: Map<K, number>): K | undefined {
  let best: K | undefined;
  let n = 0;
  for (const [k, c] of m) {
    if (c > n || (c === n && best !== undefined && k < best)) {
      best = k;
      n = c;
    }
  }
  return best;
}

type Bag = {
  colours: Tally;
  radii: Tally;
  shadows: Tally;
  fonts: Tally;
  type: Tally;
  spacing: Tally;
  rules: Map<string, { count: number; rank: number; fit: number; at: number }>;
  platforms: Set<Platform>;
};

function newBag(): Bag {
  return {
    colours: new Tally(), radii: new Tally(), shadows: new Tally(), fonts: new Tally(),
    type: new Tally(), spacing: new Tally(), rules: new Map(), platforms: new Set(),
  };
}

/**
 * How much a selector is a control's own rule rather than a special case of
 * one: a single compound (`.btn`, `.btn.is-solid`) over a nested one
 * (`.album-size button`), and a named variant (primary, solid, outline…) over
 * an unnamed one — the variants are what a mockup tells buttons apart by.
 */
function baseness(selector: string): number {
  const simple = !/[\s>+~]/.test(selector.trim()) ? 2 : 0;
  const variant = /(primary|secondary|solid|outline|ghost|default|danger|destructive)/i.test(selector) ? 1 : 0;
  return simple + variant;
}

/** How much of a look a rule sets: its declarations, capped so a kitchen-sink rule does not win on bulk. */
function richness(rule: string): number {
  return Math.min(6, (rule.match(/;/g)?.length ?? 0) + 1);
}

function addRule(bag: Bag, rule: string | null, selector: string) {
  if (!rule) return;
  const known = bag.rules.get(rule);
  if (known) known.count++;
  else bag.rules.set(rule, { count: 1, rank: controlRank(selector), fit: baseness(selector), at: bag.rules.size });
}

const weight = (n: number | string) => `font-weight: ${n}`;

// ---------------------------------------------------------------- colour values

const NAMED: Record<string, string> = {
  white: "#ffffff", black: "#000000", transparent: "transparent", red: "#ff0000",
  green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", navy: "#000080", teal: "#008080",
  maroon: "#800000", pink: "#ffc0cb", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9", whitesmoke: "#f5f5f5", gold: "#ffd700", tomato: "#ff6347",
};

/** A CSS colour literal, normalised so the same colour merges: hex where it can be, else verbatim. */
export function colour(raw: string): string | null {
  const v = raw.trim();
  const lower = v.toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(lower);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return rgba(r, g, b, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
  }
  const fn = /^(rgba?|hsla?)\(\s*([^()]*)\)$/.exec(lower);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const alpha = parts[3] === undefined ? 1 : fraction(parts[3]);
    if (alpha === null) return null;
    if (fn[1].startsWith("rgb")) {
      const [r, g, b] = parts.slice(0, 3).map((p) => (p.endsWith("%") ? num(p.slice(0, -1)) * 2.55 : num(p)));
      return [r, g, b].some(Number.isNaN) ? null : rgba(r, g, b, alpha);
    }
    const h = num(parts[0].replace(/deg$/, ""));
    const s = num(parts[1].replace(/%$/, "")) / 100;
    const l = num(parts[2].replace(/%$/, "")) / 100;
    if ([h, s, l].some(Number.isNaN)) return null;
    const [r, g, b] = hslToRgb(h, s, l);
    return rgba(r, g, b, alpha);
  }
  if (/^(oklch|oklab|lab|lch|hwb|color)\([^()]*\)$/.test(lower)) return collapse(v);
  return NAMED[lower] ?? null;
}

function fraction(p: string): number | null {
  const n = p.endsWith("%") ? num(p.slice(0, -1)) / 100 : num(p);
  return Number.isNaN(n) ? null : n;
}

function num(s: string): number {
  return /^-?\d*\.?\d+$/.test(s.trim()) ? Number(s) : NaN;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

export function rgba(r: number, g: number, b: number, a = 1): string {
  const [R, G, B] = [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))));
  if (a >= 0.995) return `#${[R, G, B].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${R}, ${G}, ${B}, ${fmt(Math.max(0, a))})`;
}

/** `#AARRGGBB` (Android, Compose, Flutter put alpha first) to CSS. */
function argb(hex: string): string | null {
  const h = hex.replace(/^#|^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) return null;
  if (h.length === 3 || h.length === 6) return colour(`#${h}`);
  if (h.length === 4) return colour(`#${h.slice(1)}${h[0]}`);
  if (h.length === 8) return colour(`#${h.slice(2)}${h.slice(0, 2)}`);
  return null;
}

function withAlpha(css: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/.exec(css);
  if (hex) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
    return rgba(r, g, b, alpha);
  }
  const rgbaMatch = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(css);
  if (rgbaMatch) return rgba(+rgbaMatch[1], +rgbaMatch[2], +rgbaMatch[3], +rgbaMatch[4] * alpha);
  return `color-mix(in srgb, ${css} ${fmt(alpha * 100)}%, transparent)`;
}

/** A 0–1 channel, or a 0–255 one, or `40 / 255`. */
function channel(expr: string): number | null {
  const m = /^\s*(\d*\.?\d+)[fF]?\s*(?:\/\s*(\d*\.?\d+)[fF]?)?\s*$/.exec(expr);
  if (!m) return null;
  return m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
}

function fromChannels(parts: (string | undefined)[], scale255 = false): string | null {
  const values = parts.map((p) => (p === undefined ? undefined : channel(p)));
  if (values.slice(0, 3).some((v) => v === null || v === undefined)) return null;
  const [r, g, b] = values as number[];
  const big = scale255 || r > 1 || g > 1 || b > 1;
  const k = big ? 1 : 255;
  const a = values[3];
  return rgba(r * k, g * k, b * k, a === undefined || a === null ? 1 : a > 1 ? a / 255 : a);
}

// ---------------------------------------------------------------- lengths

/** A length as px: rem at 16px, dp and sp at 1px, a bare number as px. Null if it is not one. */
function px(raw: string): string | null {
  const v = raw.trim();
  const m = /^(-?\d*\.?\d+)(px|rem|dp|sp|pt)?$/.exec(v);
  if (m) return `${fmt(Number(m[1]) * (m[2] === "rem" ? 16 : 1))}px`;
  const calc = /^calc\(\s*(-?\d*\.?\d+)(px|rem)\s*([-+*])\s*(\d*\.?\d+)(px|rem)?\s*\)$/.exec(v);
  if (calc) {
    const a = Number(calc[1]) * (calc[2] === "rem" ? 16 : 1);
    const b = Number(calc[4]) * (calc[5] === "rem" ? 16 : 1);
    return `${fmt(calc[3] === "+" ? a + b : calc[3] === "-" ? a - b : a * b)}px`;
  }
  return null;
}

/** Each part of a shorthand as px where it converts. */
function lengths(value: string): string {
  const whole = px(value);
  if (whole || value.includes("(")) return whole ?? collapse(value);
  return value.trim().split(/\s+/).map((p) => px(p) ?? p).join(" ");
}

function fmt(n: number): string {
  const v = Number(n.toFixed(2));
  return String(Object.is(v, -0) ? 0 : v);
}

function fontStack(name: string): string {
  const v = collapse(name);
  if (v.includes(",") || /^["']/.test(v) || !/\s/.test(v)) return v;
  return `"${v}"`;
}

/** `urbanist_semibold` → `Urbanist`, `OpenSans-Bold` → `Open Sans`. */
function fontName(resource: string): string {
  const base = resource
    .replace(/[-_](thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|heavy|black|italic|variable|vf)+$/i, "")
    .replace(/[-_](thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|bold|extrabold|heavy|black|italic)$/i, "");
  return base
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------- roles

function roleOf(name?: string): Role | undefined {
  if (!name) return undefined;
  const n = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  if (/(^|[\s._-])on[\s._-]|text|label|foreground|(^|[\s._-])fg($|[\s._-])|ink|title|caption|font/.test(n)) return "text";
  if (/border|stroke|outline|divider|separator|(^|[\s._-])ring($|[\s._-])|hairline/.test(n)) return "border";
  if (/background|(^|[\s._-])bg($|[\s._-])|surface|card|scaffold|window|paper|canvas|container|backdrop|fill|sheet/.test(n)) return "background";
  if (/primary|secondary|tertiary|accent|brand|tint|seed|highlight|link|action|success|warning|danger|error|info|destructive|button/.test(n)) return "accent";
  return undefined;
}

// ---------------------------------------------------------------- scanning helpers

function skipString(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) {
    if (text[j] === "\\") j++;
    else if (q !== "`" && text[j] === "\n") break;
    j++;
  }
  return j;
}

/** The body inside the bracket at `open`, to its match, past strings and comments. */
export function balanced(text: string, open: number, limit = 40_000): string {
  const closer: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  const end = Math.min(text.length, open + limit);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
    } else if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? end : e;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? end : e + 1;
    } else if (closer[c]) {
      stack.push(closer[c]);
    } else if (c === ")" || c === "}" || c === "]") {
      stack.pop();
      if (!stack.length) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1, end);
}

/** The string literals in a stretch of code; a template's `${}` holes are dropped. */
function stringsIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g)) {
    out.push(m[1] ?? m[2] ?? m[3].replace(/\$\{[^}]*\}/g, " "));
  }
  return out;
}

/** Where an expression at `i` in an object body ends: the next `,` or `}` at its own depth. */
function skipExpr(body: string, i: number): number {
  let depth = 0;
  for (; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(body, i);
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return i;
  }
  return i;
}

export type Leaf = { path: string[]; value: string; kind: "string" | "number" | "array" };

/**
 * The literal values in a JS object literal's body, by key path — enough of a
 * parser for a theme, a token file or a StyleSheet. Anything computed is
 * skipped rather than guessed.
 */
export function leaves(body: string): Leaf[] {
  const out: Leaf[] = [];
  const path: string[] = [];
  let key: string | null = null;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (/[\s,;]/.test(c)) {
      i++;
    } else if (c === "/" && body[i + 1] === "/") {
      const e = body.indexOf("\n", i);
      i = e < 0 ? body.length : e;
    } else if (c === "/" && body[i + 1] === "*") {
      const e = body.indexOf("*/", i + 2);
      i = e < 0 ? body.length : e + 2;
    } else if (c === "}") {
      path.pop();
      key = null;
      i++;
    } else if (key === null) {
      const m = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$-]*|\d+(?:\.\d+)?)|\[\s*["'`]?([^\]"'`]*)["'`]?\s*\])\s*:/.exec(
        body.slice(i, i + 200),
      );
      if (!m) {
        i = skipExpr(body, i);
        if (body[i] !== "}") i++;
        continue;
      }
      key = m[1] ?? m[2] ?? m[3] ?? m[4];
      i += m[0].length;
    } else if (c === "{") {
      path.push(key);
      key = null;
      i++;
    } else {
      const end = skipExpr(body, i);
      const expr = body.slice(i, end).trim();
      const str = /^(["'`])([\s\S]*)\1$/.exec(expr);
      if (str && !(str[1] === "`" && str[2].includes("${"))) {
        out.push({ path: [...path, key], value: str[2], kind: "string" });
      } else if (/^-?\d*\.?\d+$/.test(expr)) {
        out.push({ path: [...path, key], value: expr, kind: "number" });
      } else if (expr.startsWith("[")) {
        const strings = stringsIn(expr);
        if (strings.length) out.push({ path: [...path, key], value: strings.join(", "), kind: "array" });
      }
      key = null;
      i = end;
      if (body[i] !== "}") i++;
    }
  }
  return out;
}

/** The body of the `{…}` the pattern ends on, braces balanced; "" if absent. */
export function objectAfter(text: string, pattern: RegExp): string {
  const m = pattern.exec(text);
  if (!m) return "";
  return balanced(text, (m.index ?? 0) + m[0].length - 1);
}

/** Comments out of a config file, sparing the `//` in a URL. */
export function uncomment(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The `name:` or `name =` a value is assigned to, if it is. */
function keyBefore(text: string, at: number): string | undefined {
  const m = /([A-Za-z_$][\w$]*)(?:\s*:\s*[A-Z][\w.?]*)?\s*[:=]\s*(?:const\s+|new\s+|final\s+)?$/.exec(
    text.slice(Math.max(0, at - 80), at),
  );
  return m?.[1];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type Entries = [string, string][];

// ---------------------------------------------------------------- css

const STYLE_FILE = /\.(css|scss|sass|less|styl)$/i;
const MARKUP_FILE = /\.(vue|svelte|html|astro)$/i;
const SCRIPT_FILE = /\.(tsx|jsx|ts|js|mjs|cjs|vue|svelte|html|astro|mdx)$/i;
/** What a person drawing a screen needs spelled out for a control. */
const CONTROL = /(button|btn|cta|link|input|field|card|chip|tag|badge|tab|pill)/i;
/** Declarations a still picture cannot show. */
const UNSEEN = /^(transition|animation|cursor|will-change|user-select|pointer-events|outline-offset)/;
const DARK = /(^|[\s,(])(\.dark\b|\[data-(theme|mode|color-scheme)=["']?dark|:root\.dark|html\.dark)/;

type Sheet = { path: string; text: string };

/** Every style sheet, and the `<style>` blocks of single-file components and pages. */
function styleSources(entries: Entries): Sheet[] {
  const out: Sheet[] = [];
  for (const [path, text] of entries) {
    if (STYLE_FILE.test(path)) out.push({ path, text });
    else if (MARKUP_FILE.test(path)) {
      for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push({ path, text: m[1] });
    }
  }
  return out;
}

/** Custom properties by name, the styling concern's own first, then every sheet in path order. */
function tokenMap(files: ParsedFile[], sheets: Sheet[]): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const f of [...files].sort((a, b) => compare(a.path, b.path))) {
    for (const t of f.cssTokens) if (!tokens.has(t.name)) tokens.set(t.name, t.value);
  }
  for (const sheet of sheets) {
    const clean = sheet.text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of clean.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
      if (!tokens.has(m[1])) tokens.set(m[1], collapse(m[2]));
    }
  }
  return tokens;
}

function resolveVars(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 6 || !value.includes("var(")) return value;
  const next = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
    (m, name: string, fallback: string | undefined) => tokens.get(name) ?? fallback?.trim() ?? m,
  );
  return next === value ? value : resolveVars(next, tokens, depth + 1);
}

type Rule = { selector: string; decls: [string, string][]; apply: string[] };

/** Flat rules out of a style sheet: innermost blocks, so nesting and @media are read through. */
function rules(text: string): Rule[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const out: Rule[] = [];
  for (const m of clean.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = collapse(m[1]);
    if (!selector || selector.startsWith("@") || /^(from|to|\d+%)/.test(selector)) continue;
    const decls: [string, string][] = [];
    const apply: string[] = [];
    for (const part of m[2].split(";")) {
      const trimmed = part.trim();
      const applied = /^@apply\s+([\s\S]+)$/.exec(trimmed);
      if (applied) {
        apply.push(...applied[1].split(/\s+/).filter(Boolean));
        continue;
      }
      if (trimmed.startsWith("@")) continue;
      const at = trimmed.indexOf(":");
      if (at < 0) continue;
      const prop = trimmed.slice(0, at).trim().toLowerCase();
      const value = collapse(trimmed.slice(at + 1));
      if (prop && value && !prop.startsWith("--")) decls.push([prop, value]);
    }
    out.push({ selector, decls, apply });
  }
  return out;
}

const COLOUR_PROPS: [RegExp, Role][] = [
  [/^color$|^caret-color$|^text-decoration-color$/, "text"],
  [/^background(-color)?$/, "background"],
  [/^(border|outline)(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/, "border"],
  [/^(fill|stroke|accent-color)$/, "accent"],
];

/** The colours a declaration's value names, each with the token it came through, if any. */
function coloursIn(value: string, tokens: Map<string, string>): { css: string; name?: string }[] {
  const out: { css: string; name?: string }[] = [];
  let rest = value;
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)[^()]*(?:\([^()]*\))?[^()]*\)/g)) {
    const resolved = resolveVars(m[0], tokens);
    const css = colour(resolved) ?? literalColour(resolved);
    if (css) out.push({ css, name: m[1] });
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]*\)|\b[a-zA-Z]+\b/g)) {
    const css = colour(m[0]);
    if (css) out.push({ css });
  }
  return out;
}

function literalColour(value: string): string | null {
  const m = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^()]*\)/.exec(value);
  return m ? colour(m[0]) : null;
}

function readCss(sheets: Sheet[], tokens: Map<string, string>, ctx: TwContext | null, bag: Bag) {
  if (sheets.some((s) => STYLE_FILE.test(s.path))) bag.platforms.add("css");
  for (const sheet of sheets) {
    for (const rule of rules(sheet.text)) {
      if (DARK.test(rule.selector)) continue;
      for (const [prop, raw] of rule.decls) {
        const value = resolveVars(raw, tokens);
        const role = COLOUR_PROPS.find(([p]) => p.test(prop))?.[1];
        if (role) for (const c of coloursIn(raw, tokens)) bag.colours.add(c.css, c.name, role);
        const name = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw)?.[1];
        if (/^border(-[a-z]+)*-radius$/.test(prop)) bag.radii.add(lengths(value), name);
        else if (prop === "box-shadow") bag.shadows.add(collapse(value), name);
        else if (prop === "font-family" && !/^(inherit|initial|unset)$/.test(value)) bag.fonts.add(collapse(value), name);
        else if (prop === "font-size") bag.type.add(px(value), name);
        else if (prop === "font-weight") bag.type.add(cssWeight(value), name);
        else if (/^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|block|inline))?$/.test(prop)) {
          for (const part of value.split(/\s+/)) {
            const len = px(part);
            if (len && len !== "0px" && !len.startsWith("-")) bag.spacing.add(len, name);
          }
        }
      }
      if (ctx) for (const cls of rule.apply) countClass(cls, ctx, bag);

      if (!CONTROL.test(rule.selector)) continue;
      const translated = ctx && rule.apply.length ? declarations(rule.apply, ctx) : [];
      const decls = [
        ...translated,
        ...rule.decls.filter(([p]) => !UNSEEN.test(p)).map(([p, v]) => `${p}: ${v}`),
      ].slice(0, DECLS_SHOWN);
      // One declaration is a tweak, not a look.
      if (decls.length >= 2) addRule(bag, `${rule.selector} { ${decls.join("; ")} }`, rule.selector);
    }
  }
}

function cssWeight(value: string): string | null {
  if (/^\d{3}$/.test(value)) return weight(value);
  if (value === "bold") return weight(700);
  if (value === "normal") return weight(400);
  return null;
}

/** Buttons first: they are what a mockup draws most, and get wrong most. */
function controlRank(selector: string): number {
  if (/button|btn|cta/i.test(selector)) return 0;
  if (/input|field/i.test(selector)) return 1;
  if (/link|^a\b/i.test(selector)) return 2;
  return 3;
}

// ---------------------------------------------------------------- tailwind

const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
/** Tailwind v3's default palette, shades 50–950. */
const TAILWIND: Record<string, string> = {
  slate: "f8fafc f1f5f9 e2e8f0 cbd5e1 94a3b8 64748b 475569 334155 1e293b 0f172a 020617",
  gray: "f9fafb f3f4f6 e5e7eb d1d5db 9ca3af 6b7280 4b5563 374151 1f2937 111827 030712",
  zinc: "fafafa f4f4f5 e4e4e7 d4d4d8 a1a1aa 71717a 52525b 3f3f46 27272a 18181b 09090b",
  neutral: "fafafa f5f5f5 e5e5e5 d4d4d4 a3a3a3 737373 525252 404040 262626 171717 0a0a0a",
  stone: "fafaf9 f5f5f4 e7e5e4 d6d3d1 a8a29e 78716c 57534e 44403c 292524 1c1917 0c0a09",
  red: "fef2f2 fee2e2 fecaca fca5a5 f87171 ef4444 dc2626 b91c1c 991b1b 7f1d1d 450a0a",
  orange: "fff7ed ffedd5 fed7aa fdba74 fb923c f97316 ea580c c2410c 9a3412 7c2d12 431407",
  amber: "fffbeb fef3c7 fde68a fcd34d fbbf24 f59e0b d97706 b45309 92400e 78350f 451a03",
  yellow: "fefce8 fef9c3 fef08a fde047 facc15 eab308 ca8a04 a16207 854d0e 713f12 422006",
  lime: "f7fee7 ecfccb d9f99d bef264 a3e635 84cc16 65a30d 4d7c0f 3f6212 365314 1a2e05",
  green: "f0fdf4 dcfce7 bbf7d0 86efac 4ade80 22c55e 16a34a 15803d 166534 14532d 052e16",
  emerald: "ecfdf5 d1fae5 a7f3d0 6ee7b7 34d399 10b981 059669 047857 065f46 064e3b 022c22",
  teal: "f0fdfa ccfbf1 99f6e4 5eead4 2dd4bf 14b8a6 0d9488 0f766e 115e59 134e4a 042f2e",
  cyan: "ecfeff cffafe a5f3fc 67e8f9 22d3ee 06b6d4 0891b2 0e7490 155e75 164e63 083344",
  sky: "f0f9ff e0f2fe bae6fd 7dd3fc 38bdf8 0ea5e9 0284c7 0369a1 075985 0c4a6e 082f49",
  blue: "eff6ff dbeafe bfdbfe 93c5fd 60a5fa 3b82f6 2563eb 1d4ed8 1e40af 1e3a8a 172554",
  indigo: "eef2ff e0e7ff c7d2fe a5b4fc 818cf8 6366f1 4f46e5 4338ca 3730a3 312e81 1e1b4b",
  violet: "f5f3ff ede9fe ddd6fe c4b5fd a78bfa 8b5cf6 7c3aed 6d28d9 5b21b6 4c1d95 2e1065",
  purple: "faf5ff f3e8ff e9d5ff d8b4fe c084fc a855f7 9333ea 7e22ce 6b21a8 581c87 3b0764",
  fuchsia: "fdf4ff fae8ff f5d0fe f0abfc e879f9 d946ef c026d3 a21caf 86198f 701a75 4a044e",
  pink: "fdf2f8 fce7f3 fbcfe8 f9a8d4 f472b6 ec4899 db2777 be185d 9d174d 831843 500724",
  rose: "fff1f2 ffe4e6 fecdd3 fda4af fb7185 f43f5e e11d48 be123c 9f1239 881337 4c0519",
};

const TW_RADII: Record<string, string> = {
  none: "0px", xs: "2px", sm: "2px", DEFAULT: "4px", md: "6px", lg: "8px", xl: "12px",
  "2xl": "16px", "3xl": "24px", "4xl": "32px", full: "9999px",
};
const TW_SHADOWS: Record<string, string> = {
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
  inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
  none: "none",
};
const TW_SIZES: Record<string, string> = {
  xs: "12px", sm: "14px", base: "16px", lg: "18px", xl: "20px", "2xl": "24px", "3xl": "30px",
  "4xl": "36px", "5xl": "48px", "6xl": "60px", "7xl": "72px", "8xl": "96px", "9xl": "128px",
};
const TW_WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700,
  extrabold: 800, black: 900,
};
const TW_FONTS: Record<string, string> = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

type TwContext = {
  tokens: Map<string, string>;
  v4: boolean;
  unit: number;
  colors: Map<string, string>;
  radii: Map<string, string>;
  shadows: Map<string, string>;
  fonts: Map<string, string>;
  sizes: Map<string, string>;
  spacing: Map<string, string>;
};

/**
 * Tailwind's theme, when the repo uses Tailwind at all — a `bg-blue-600` in a
 * Bootstrap app is not blue-600, so class names alone do not count. v4 themes
 * come through the CSS token map (`--color-brand`), v3 through the config.
 */
function tailwindContext(entries: Entries, tokens: Map<string, string>): TwContext | null {
  let used = false;
  let v4 = false;
  const config = {
    colors: new Map<string, string>(), radii: new Map<string, string>(), shadows: new Map<string, string>(),
    fonts: new Map<string, string>(), sizes: new Map<string, string>(), spacing: new Map<string, string>(),
  };
  for (const [path, text] of entries) {
    if (/(^|\/)tailwind\.config\.[^/]+$/.test(path)) {
      used = true;
      readTailwindConfig(uncomment(text), config);
    } else if (STYLE_FILE.test(path)) {
      if (/@import\s+["']tailwindcss/.test(text)) used = v4 = true;
      else if (/@tailwind\s+(base|components|utilities)/.test(text)) used = true;
    } else if (/(^|\/)package\.json$/.test(path) && /"(tailwindcss|@tailwindcss\/[\w-]+)"\s*:/.test(text)) {
      used = true;
      if (/"(@tailwindcss\/[\w-]+|tailwindcss)"\s*:\s*"[\^~]?4/.test(text)) v4 = true;
    } else if (/(^|\/)postcss\.config\.[^/]+$/.test(path) && /tailwindcss/.test(text)) {
      used = true;
    }
  }
  if (!used) return null;
  const spacing = tokens.get("--spacing");
  const unit = spacing ? Number(px(resolveVars(spacing, tokens))?.replace("px", "") ?? 4) || 4 : 4;
  return { tokens, v4, unit, ...config };
}

function readTailwindConfig(text: string, config: Omit<TwContext, "tokens" | "v4" | "unit">) {
  const theme = objectAfter(text, /\btheme\s*:\s*\{/);
  const sections: Record<string, Map<string, string>> = {
    colors: config.colors, borderRadius: config.radii, boxShadow: config.shadows,
    fontFamily: config.fonts, fontSize: config.sizes, spacing: config.spacing,
  };
  for (const leaf of leaves(theme)) {
    const path = leaf.path[0] === "extend" ? leaf.path.slice(1) : leaf.path;
    const into = sections[path[0]];
    if (!into || path.length < 2) continue;
    const rest = path.slice(1);
    const key =
      path[0] === "colors" ? rest.filter((k) => k !== "DEFAULT").join("-") : rest.join("-");
    const value = path[0] === "fontSize" && leaf.kind === "array" ? leaf.value.split(", ")[0] : leaf.value;
    if (path[0] === "fontFamily" && leaf.kind === "array") {
      into.set(key, leaf.value.split(", ").map(fontStack).join(", "));
    } else if (!into.has(key)) {
      into.set(key, value);
    }
  }
}

type Effect =
  | { k: "colour"; prop: string; role: Role; css: string }
  | { k: "radius" | "shadow" | "font" | "size" | "weight" | "border" | "height" | "case"; css: string }
  | { k: "space"; prop: string; css: string };

const COLOUR_UTILITY =
  /^(bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|divide|fill|stroke|from|via|to|accent|decoration|placeholder|caret)-(.+)$/;

function utilityRole(prefix: string): Role {
  if (prefix === "bg" || prefix === "from" || prefix === "via" || prefix === "to") return "background";
  if (["text", "decoration", "placeholder", "caret"].includes(prefix)) return "text";
  if (prefix === "fill" || prefix === "stroke" || prefix === "accent") return "accent";
  return "border";
}

function arbitrary(value: string): string | null {
  const m = /^\[(.+)\]$/.exec(value);
  return m ? m[1].replace(/_/g, " ") : null;
}

function twColour(value: string, ctx: TwContext): string | null {
  let v = value;
  let alpha: number | undefined;
  const slash = /^(.+)\/(\d{1,3}|\[(\d*\.?\d+)(%?)\])$/.exec(v);
  if (slash) {
    v = slash[1];
    alpha = slash[3] !== undefined ? Number(slash[3]) / (slash[4] ? 100 : 1) : Number(slash[2]) / 100;
  }
  let css: string | null = null;
  const raw = arbitrary(v);
  if (raw !== null) {
    const inner = raw.replace(/^color:/, "");
    css = colour(resolveVars(inner.startsWith("--") ? `var(${inner})` : inner, ctx.tokens));
  } else if (v === "white" || v === "black" || v === "transparent") {
    css = NAMED[v];
  } else if (ctx.tokens.has(`--color-${v}`)) {
    const resolved = resolveVars(ctx.tokens.get(`--color-${v}`)!, ctx.tokens);
    css = colour(resolved) ?? literalColour(resolved);
  } else if (ctx.colors.has(v)) {
    const resolved = resolveVars(ctx.colors.get(v)!, ctx.tokens);
    css = colour(resolved) ?? literalColour(resolved);
  } else {
    const m = /^([a-z]+)-(\d{2,3})$/.exec(v);
    const shade = m ? SHADES.indexOf(m[2]) : -1;
    if (m && TAILWIND[m[1]] && shade >= 0) css = `#${TAILWIND[m[1]].split(" ")[shade]}`;
  }
  if (!css) return null;
  return alpha === undefined ? css : withAlpha(css, alpha);
}

function themed(
  key: string,
  ctx: TwContext,
  token: string,
  own: Map<string, string>,
  defaults: Record<string, string>,
): string | null {
  const raw = arbitrary(key);
  if (raw !== null) return raw;
  const t = ctx.tokens.get(token);
  if (t !== undefined) return resolveVars(t, ctx.tokens);
  const c = own.get(key);
  if (c !== undefined) return resolveVars(c, ctx.tokens);
  return defaults[key] ?? null;
}

/** One utility class as the CSS it stands for; null if it is not one we can say. */
function utility(cls: string, ctx: TwContext): Effect | null {
  if (/^(uppercase|lowercase|capitalize)$/.test(cls)) return { k: "case", css: cls };

  let m = /^rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es))?(?:-(.+))?$/.exec(cls);
  if (m) {
    const key = m[1] ?? "DEFAULT";
    const v = themed(key, ctx, key === "DEFAULT" ? "--radius-DEFAULT" : `--radius-${key}`, ctx.radii, TW_RADII);
    return v === null ? null : { k: "radius", css: lengths(v) };
  }
  m = /^shadow(?:-(.+))?$/.exec(cls);
  if (m) {
    const key = m[1] ?? "DEFAULT";
    const v = themed(key, ctx, key === "DEFAULT" ? "--shadow-DEFAULT" : `--shadow-${key}`, ctx.shadows, TW_SHADOWS);
    return v === null || colour(v) ? null : { k: "shadow", css: collapse(v) };
  }
  m = /^font-(.+)$/.exec(cls);
  if (m) {
    if (TW_WEIGHTS[m[1]]) return { k: "weight", css: weight(TW_WEIGHTS[m[1]]) };
    const raw = arbitrary(m[1]);
    if (raw !== null) return /^\d{3}$/.test(raw) ? { k: "weight", css: weight(raw) } : { k: "font", css: fontStack(raw.replace(/["']/g, "")) };
    const v = themed(m[1], ctx, `--font-${m[1]}`, ctx.fonts, TW_FONTS);
    return v === null ? null : { k: "font", css: collapse(v) };
  }
  m = /^text-(.+?)(?:\/[\w.[\]]+)?$/.exec(cls);
  if (m && (TW_SIZES[m[1]] || ctx.tokens.has(`--text-${m[1]}`) || ctx.sizes.has(m[1]))) {
    const v = themed(m[1], ctx, `--text-${m[1]}`, ctx.sizes, TW_SIZES);
    return v === null ? null : { k: "size", css: px(v) ?? v };
  }
  m = /^text-\[(.+)\]$/.exec(cls);
  if (m && px(m[1].replace(/_/g, " "))) return { k: "size", css: px(m[1])! };

  m = /^(p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-(.+)$/.exec(cls);
  if (m) {
    const key = m[2];
    const raw = arbitrary(key);
    const v =
      key === "px" ? "1px"
        : /^\d+(\.\d+)?$/.test(key) ? `${fmt(Number(key) * ctx.unit)}px`
          : raw !== null ? px(raw)
            : ctx.spacing.has(key) ? px(resolveVars(ctx.spacing.get(key)!, ctx.tokens)) : null;
    return v ? { k: "space", prop: m[1], css: v } : null;
  }
  m = /^(?:h|size)-(\d+(?:\.\d+)?|\[.+\])$/.exec(cls);
  if (m) {
    const raw = arbitrary(m[1]);
    const v = raw !== null ? px(raw) : `${fmt(Number(m[1]) * ctx.unit)}px`;
    return v ? { k: "height", css: v } : null;
  }
  m = /^border(?:-(\d+|\[.+\]))?$/.exec(cls);
  if (m) {
    const raw = m[1] ? arbitrary(m[1]) : null;
    const v = !m[1] ? "1px" : raw !== null ? px(raw) : `${m[1]}px`;
    if (v) return { k: "border", css: v };
  }
  m = COLOUR_UTILITY.exec(cls);
  if (m) {
    const css = twColour(m[2], ctx);
    if (!css) return null;
    const prefix = m[1].replace(/-.*$/, "");
    const role = utilityRole(prefix);
    const prop = prefix === "bg" ? "background" : prefix === "text" ? "color" : prefix === "border" ? "border-color" : prefix;
    return { k: "colour", prop, role, css };
  }
  return null;
}

/** `md:hover:bg-x` → `["md","hover"]`, `bg-x`; colons inside `[...]` are not variants. */
function variants(cls: string): { variants: string[]; base: string } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === "[") depth++;
    else if (cls[i] === "]") depth--;
    else if (cls[i] === ":" && depth === 0) {
      parts.push(cls.slice(start, i));
      start = i + 1;
    }
  }
  return { variants: parts, base: cls.slice(start).replace(/^!|!$/g, "") };
}

/** Counts a class toward the look; dark-mode variants describe another look and are left out. */
function countClass(cls: string, ctx: TwContext, bag: Bag): boolean {
  const { variants: vs, base } = variants(cls);
  if (vs.includes("dark") || base.startsWith("-")) return false;
  const e = utility(base, ctx);
  if (!e) return false;
  if (e.k === "colour") bag.colours.add(e.css, base, e.role);
  else if (e.k === "radius") bag.radii.add(e.css, base);
  else if (e.k === "shadow") bag.shadows.add(e.css, base);
  else if (e.k === "font") bag.fonts.add(e.css, base);
  else if (e.k === "size" || e.k === "weight") bag.type.add(e.css, base);
  else if (e.k === "space") bag.spacing.add(e.css, base);
  else return false;
  return true;
}

/** A control's resting look from its classes, as declarations. */
function declarations(classes: string[], ctx: TwContext): string[] {
  const at: Partial<Record<"background" | "color" | "radius" | "font" | "size" | "weight" | "height" | "case" | "shadow" | "borderW" | "borderC", string>> = {};
  const pad: { t?: string; r?: string; b?: string; l?: string } = {};
  for (const cls of classes) {
    const { variants: vs, base } = variants(cls);
    if (vs.length) continue;
    const e = utility(base, ctx);
    if (!e) continue;
    if (e.k === "colour") {
      if (e.prop === "background") at.background = e.css;
      else if (e.prop === "color") at.color = e.css;
      else if (e.prop === "border-color") at.borderC = e.css;
    } else if (e.k === "space") {
      const side = e.prop.slice(1);
      if (!e.prop.startsWith("p")) continue;
      if (side === "" || side === "y" || side === "t") pad.t = e.css;
      if (side === "" || side === "y" || side === "b") pad.b = e.css;
      if (side === "" || side === "x" || side === "l" || side === "s") pad.l = e.css;
      if (side === "" || side === "x" || side === "r" || side === "e") pad.r = e.css;
    } else if (e.k === "radius") at.radius = e.css;
    else if (e.k === "border") at.borderW = e.css;
    else at[e.k] = e.css;
  }
  const decls: string[] = [];
  if (at.background) decls.push(`background: ${at.background}`);
  if (at.color) decls.push(`color: ${at.color}`);
  if (at.borderW) decls.push(`border: ${at.borderW} solid ${at.borderC ?? (ctx.v4 ? "currentColor" : "#e5e7eb")}`);
  if (at.radius) decls.push(`border-radius: ${at.radius}`);
  if (pad.t || pad.r || pad.b || pad.l) {
    const [t, r, b, l] = [pad.t, pad.r, pad.b, pad.l].map((v) => v ?? "0");
    decls.push(`padding: ${t === r && r === b && b === l ? t : t === b && l === r ? `${t} ${r}` : `${t} ${r} ${b} ${l}`}`);
  }
  if (at.height) decls.push(`height: ${at.height}`);
  if (at.font) decls.push(`font-family: ${at.font}`);
  if (at.size) decls.push(`font-size: ${at.size}`);
  if (at.weight) decls.push(at.weight);
  if (at.case) decls.push(`text-transform: ${at.case}`);
  if (at.shadow) decls.push(`box-shadow: ${at.shadow}`);
  return decls;
}

function translate(selector: string, classes: string[], ctx: TwContext): string | null {
  const decls = declarations(classes, ctx);
  return decls.length >= 2 ? `${selector} { ${decls.join("; ")} }` : null;
}

const CLASS_ATTR =
  /(?<![\w-])(?:class|className)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\}|\{\s*`([^`]*)`\s*\})/g;
const CLASS_CALL = /(?<![\w$.])(?:clsx|cn|cx|cva|tv|twMerge|twJoin|classNames|classnames)\s*\(/g;

/** Every class list a file writes: attributes, and the strings passed to cn/clsx/cva. */
function classLists(text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(CLASS_ATTR)) {
    const list = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).replace(/\$\{[^}]*\}/g, " ");
    out.push(list.split(/\s+/).filter(Boolean));
  }
  for (const m of text.matchAll(CLASS_CALL)) {
    const body = balanced(text, (m.index ?? 0) + m[0].length - 1, 8000);
    for (const s of stringsIn(body)) out.push(s.split(/\s+/).filter(Boolean));
  }
  return out;
}

const CONTROL_TAGS: Record<string, string> = {
  button: "button", a: "a", Link: "a", input: "input", select: "select", textarea: "textarea",
};

/** The opening tag at `start`, to its `>`, past attribute strings and `{}` expressions. */
function openingTag(text: string, start: number): string {
  let depth = 0;
  const end = Math.min(text.length, start + 2000);
  for (let i = start + 1; i < end; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(text, i);
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth <= 0) return text.slice(start, i + 1);
  }
  return "";
}

function readTailwind(entries: Entries, ctx: TwContext, bag: Bag) {
  let used = false;
  for (const [path, text] of entries) {
    if (!SCRIPT_FILE.test(path) || /(^|\/)tailwind\.config\.[^/]+$/.test(path)) continue;
    for (const list of classLists(text)) {
      for (const cls of list) if (countClass(cls, ctx, bag)) used = true;
    }
    for (const m of text.matchAll(/<([A-Za-z][\w.]*)(?=[\s>/])/g)) {
      const tag = m[1];
      const control = CONTROL_TAGS[tag];
      if (!control && !/^[a-z]/.test(tag)) continue;
      const opening = openingTag(text, m.index ?? 0);
      if (!opening || (!control && !/\b(btn|button)\b/i.test(opening))) continue;
      const classes = classLists(opening).flat();
      const named = classes.find((c) => /^(btn|button)([-_][\w-]+)?$/i.test(c));
      const selector = control ?? (named ? `.${named}` : "");
      if (selector && classes.length) addRule(bag, translate(selector, classes, ctx), selector);
    }
    readVariants(text, ctx, bag);
  }
  if (used || bag.rules.size) bag.platforms.add("tailwind");
}

/**
 * A `buttonVariants = cva(base, { variants, defaultVariants })` is the design
 * system's button, spelled out: the default, and each look of its main variant.
 */
function readVariants(text: string, ctx: TwContext, bag: Bag) {
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:cva|tv)\s*\(/g)) {
    if (!/button|btn/i.test(m[1])) continue;
    const body = balanced(text, (m.index ?? 0) + m[0].length - 1);
    const brace = body.indexOf("{");
    const head = brace < 0 ? body : body.slice(0, brace);
    const base = stringsIn(head).join(" ").split(/\s+/).filter(Boolean);
    const options = brace < 0 ? [] : leaves(balanced(body, brace));
    const groups = new Map<string, Map<string, string[]>>();
    const defaults = new Map<string, string>();
    for (const leaf of options) {
      if (leaf.path[0] === "variants" && leaf.path.length === 3 && leaf.kind !== "number") {
        const group = groups.get(leaf.path[1]) ?? new Map<string, string[]>();
        group.set(leaf.path[2], leaf.value.replace(/,/g, " ").split(/\s+/).filter(Boolean));
        groups.set(leaf.path[1], group);
      } else if (leaf.path[0] === "defaultVariants" && leaf.path.length === 2) {
        defaults.set(leaf.path[1], leaf.value);
      }
    }
    const pick = (group: string) => defaults.get(group) ?? (groups.get(group)?.has("default") ? "default" : "");
    const resting = [...groups.keys()].flatMap((g) => groups.get(g)!.get(pick(g)) ?? []);
    addRule(bag, translate("button", [...base, ...resting], ctx), "button");
    const main = [...groups.keys()].find((g) => /variant|intent|kind|color|tone|appearance/i.test(g));
    if (!main) continue;
    const others = [...groups.keys()].filter((g) => g !== main).flatMap((g) => groups.get(g)!.get(pick(g)) ?? []);
    for (const [option, classes] of [...groups.get(main)!].slice(0, 6)) {
      if (option === pick(main)) continue;
      addRule(bag, translate(`button.${option}`, [...base, ...others, ...classes], ctx), "button");
    }
  }
}

// ---------------------------------------------------------------- web fonts

/** Fonts a web app loads rather than declares: next/font, Fontsource, Google Fonts links. */
function readWebFonts(entries: Entries, bag: Bag) {
  for (const [path, text] of entries) {
    if (!SCRIPT_FILE.test(path) && !STYLE_FILE.test(path)) continue;
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/g)) {
      for (const name of m[1].split(",")) {
        const id = name.trim().split(/\s+as\s+/)[0];
        if (id) bag.fonts.add(fontStack(id.replace(/_/g, " ")), "next/font");
      }
    }
    for (const m of text.matchAll(/["']@fontsource(?:-variable)?\/([\w-]+)/g)) {
      bag.fonts.add(fontStack(fontName(m[1])), "@fontsource");
    }
    for (const m of text.matchAll(/fonts\.googleapis\.com\/css2?\?([^"')\s]+)/g)) {
      for (const f of m[1].matchAll(/family=([^:&]+)/g)) {
        bag.fonts.add(fontStack(decodeURIComponent(f[1].replace(/\+/g, " "))), "Google Fonts");
      }
    }
  }
}

// ---------------------------------------------------------------- react native

const RN_IMPORT = /from\s+["']react-native["']|require\(\s*["']react-native["']\s*\)/;

function readReactNative(entries: Entries, bag: Bag) {
  for (const [path, text] of entries) {
    if (!/\.(tsx?|jsx?)$/.test(path) || !RN_IMPORT.test(text)) continue;
    bag.platforms.add("react-native");
    for (const m of text.matchAll(/StyleSheet\.create\s*\(\s*\{/g)) {
      styleObjects(leaves(balanced(text, (m.index ?? 0) + m[0].length - 1)), bag);
    }
    for (const m of text.matchAll(/\bstyle=\{\{/g)) {
      styleObjects(leaves(balanced(text, (m.index ?? 0) + m[0].length - 1)), bag);
    }
  }
}

const RN_WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };

/** React Native style objects, grouped by style name, as CSS. */
function styleObjects(list: Leaf[], bag: Bag) {
  const groups = new Map<string, Map<string, string>>();
  for (const leaf of list) {
    const offset = leaf.path.at(-2) === "shadowOffset";
    const owner = leaf.path.slice(0, offset ? -2 : -1).join(".");
    const prop = offset ? `shadowOffset.${leaf.path.at(-1)}` : leaf.path.at(-1)!;
    const group = groups.get(owner) ?? new Map<string, string>();
    group.set(prop, leaf.value);
    groups.set(owner, group);
  }
  for (const [owner, props] of groups) {
    const name = owner || undefined;
    for (const [prop, value] of props) {
      if (prop === "backgroundColor") bag.colours.add(colour(value), name, "background");
      else if (prop === "color") bag.colours.add(colour(value), name, "text");
      else if (/^border\w*Color$/.test(prop)) bag.colours.add(colour(value), name, "border");
      else if (prop === "tintColor") bag.colours.add(colour(value), name, "accent");
      else if (/^border\w*Radius$/.test(prop)) bag.radii.add(px(value), name);
      else if (prop === "fontFamily") bag.fonts.add(fontStack(value), name);
      else if (prop === "fontSize") bag.type.add(px(value), name);
      else if (prop === "fontWeight") {
        const w = /^\d{3}$/.test(value) ? Number(value) : RN_WEIGHTS[value];
        if (w) bag.type.add(weight(w), name);
      } else if (/^(padding|margin)(Horizontal|Vertical|Top|Right|Bottom|Left|Start|End)?$|^(gap|rowGap|columnGap)$/.test(prop)) {
        const len = px(value);
        if (len && len !== "0px" && !len.startsWith("-")) bag.spacing.add(len, name);
      }
    }
    const radius = props.get("shadowRadius");
    const elevation = props.get("elevation");
    if (radius !== undefined) {
      const c = colour(props.get("shadowColor") ?? "#000000") ?? "#000000";
      const opacity = Number(props.get("shadowOpacity") ?? 1);
      const x = props.get("shadowOffset.width") ?? "0";
      const y = props.get("shadowOffset.height") ?? "0";
      bag.shadows.add(`${px(x) ?? "0px"} ${px(y) ?? "0px"} ${px(radius) ?? "0px"} ${withAlpha(c, opacity)}`, name);
    } else if (elevation !== undefined && Number(elevation) > 0) {
      bag.shadows.add(elevationShadow(Number(elevation)), `elevation ${elevation}`);
    }
  }
}

/** Material elevation as a CSS shadow: offset half the elevation, blur the whole of it. */
function elevationShadow(dp: number): string {
  return `0 ${fmt(dp / 2)}px ${fmt(dp)}px rgba(0, 0, 0, 0.2)`;
}

// ---------------------------------------------------------------- theme objects and tokens

const THEME_OBJECT =
  /(?<![\w$.])([\w$]*(?:theme|Theme|palette|Palette|colors|Colors|colours|Colours|tokens|Tokens)|light)\s*[:=]\s*(?:[\w$.]+\s*\(\s*)?\{/g;

/**
 * JS theme objects — MUI's `palette`, Chakra's `colors`, a styled-components
 * theme, Expo's `Colors` — read as named swatches and measures. Dark variants
 * are another look and are left out.
 */
function readThemeObjects(entries: Entries, bag: Bag) {
  for (const [path, text] of entries) {
    if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(path) || serverSide(path)) continue;
    if (/(^|\/)(tailwind|postcss)\.config\./.test(path)) continue;
    let consumed = -1;
    for (const m of text.matchAll(THEME_OBJECT)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (open < consumed) continue;
      const body = balanced(text, open);
      consumed = open + body.length;
      if (/dark/i.test(m[1])) continue;
      for (const leaf of leaves(body)) {
        if (leaf.path.some((k) => /dark/i.test(k))) continue;
        const name = [m[1], ...leaf.path].join(".");
        themeLeaf(name, leaf.path.at(-1)!, leaf.value, bag);
      }
    }
  }
}

function themeLeaf(name: string, key: string, value: string, bag: Bag) {
  const css = colour(value);
  if (css) bag.colours.add(css, name, roleOf(name));
  else if (/radius|rounded|corner/i.test(key)) bag.radii.add(px(value) ?? lengths(value), name);
  else if (/^font-?family$|^fonts?$/i.test(key)) bag.fonts.add(value.split(", ").map(fontStack).join(", "), name);
  else if (/font-?size/i.test(key)) bag.type.add(px(value), name);
  else if (/font-?weight/i.test(key) && /^\d{3}$/.test(value)) bag.type.add(weight(value), name);
  else if (/shadow/i.test(key) && /\d+px/.test(value)) bag.shadows.add(collapse(value), name);
}

const TOKEN_FILE = /(^|\/)((?:[\w-]+[.-])?tokens?\.json|tokens\/[^/]+\.json)$/i;

/** W3C design tokens and Style Dictionary / Tokens Studio files. */
function readTokenFiles(entries: Entries, bag: Bag) {
  for (const [path, text] of entries) {
    if (!TOKEN_FILE.test(path) || serverSide(path)) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const flat = new Map<string, { value: unknown; type?: string }>();
    const walk = (node: unknown, path: string[], type?: string) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const o = node as Record<string, unknown>;
      const own = typeof o.$type === "string" ? o.$type : typeof o.type === "string" ? o.type : type;
      if ("$value" in o || ("value" in o && typeof o.value !== "object") || ("value" in o && own)) {
        flat.set(path.join("."), { value: o.$value ?? o.value, type: own });
        return;
      }
      for (const k of Object.keys(o).sort()) if (!k.startsWith("$")) walk(o[k], [...path, k], own);
    };
    walk(json, []);
    if (!flat.size) continue;
    let found = false;
    const deref = (v: unknown, depth = 0): unknown =>
      typeof v === "string" && /^\{[^}]+\}$/.test(v) && depth < 6 ? deref(flat.get(v.slice(1, -1))?.value, depth + 1) : v;
    for (const [name, { value, type }] of flat) {
      const v = deref(value);
      const t = (type ?? "").toLowerCase();
      if (typeof v === "string" || typeof v === "number") {
        const s = String(v);
        const css = colour(s);
        if (css && (t === "" || t === "color")) {
          bag.colours.add(css, name, roleOf(name));
        } else if (/fontfamil/.test(t) || /font-?famil/i.test(name)) {
          bag.fonts.add(s.split(/,\s*/).map(fontStack).join(", "), name);
        } else if (/radius/i.test(t) || /radius|rounded|corner/i.test(name)) {
          bag.radii.add(px(s) ?? s, name);
        } else if (/fontsize/.test(t) || /font-?size/i.test(name)) {
          bag.type.add(px(s), name);
        } else if (/fontweight/.test(t) || /font-?weight/i.test(name)) {
          if (/^\d{3}$/.test(s)) bag.type.add(weight(s), name);
        } else if (/spacing|dimension|sizing/.test(t) && /spac|gap|pad|margin/i.test(name)) {
          bag.spacing.add(px(s), name);
        } else continue;
        found = true;
      } else if (Array.isArray(v) && v.every((x) => typeof x === "string") && /fontfamil|font-?famil/i.test(t + name)) {
        bag.fonts.add((v as string[]).map(fontStack).join(", "), name);
        found = true;
      } else if (v && typeof v === "object" && /shadow/i.test(t + name)) {
        const shadows = (Array.isArray(v) ? v : [v]) as Record<string, unknown>[];
        const css = shadows
          .map((s) => {
            const x = px(String(s.offsetX ?? s.x ?? 0)) ?? "0px";
            const y = px(String(s.offsetY ?? s.y ?? 0)) ?? "0px";
            const blur = px(String(s.blur ?? 0)) ?? "0px";
            const spread = px(String(s.spread ?? 0)) ?? "0px";
            const c = colour(String(deref(s.color) ?? "#000000")) ?? "#000000";
            return `${s.type === "innerShadow" || s.inset ? "inset " : ""}${x} ${y} ${blur} ${spread} ${c}`;
          })
          .join(", ");
        bag.shadows.add(css, name);
        found = true;
      }
    }
    if (found) bag.platforms.add("tokens");
  }
}

// ---------------------------------------------------------------- apple

const APPLE_COLOURS: Record<string, string> = {
  blue: "#007aff", red: "#ff3b30", green: "#34c759", orange: "#ff9500", yellow: "#ffcc00",
  pink: "#ff2d55", purple: "#af52de", teal: "#30b0c7", indigo: "#5856d6", gray: "#8e8e93",
  mint: "#00c7be", cyan: "#32ade6", brown: "#a2845e", white: "#ffffff", black: "#000000",
  clear: "transparent", label: "#000000", secondaryLabel: "rgba(60, 60, 67, 0.6)",
  background: "#ffffff", secondaryBackground: "#f2f2f7", groupedBackground: "#f2f2f7",
};
const APPLE_WEIGHTS: Record<string, number> = {
  ultraLight: 200, thin: 100, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700,
  heavy: 800, black: 900,
};
/** Dynamic Type sizes at the default setting, and their weights. */
const APPLE_TEXT: Record<string, [number, number]> = {
  largeTitle: [34, 400], title: [28, 400], title2: [22, 400], title3: [20, 400], headline: [17, 600],
  body: [17, 400], callout: [16, 400], subheadline: [15, 400], footnote: [13, 400], caption: [12, 400],
  caption2: [11, 400],
};
const SYSTEM_FONT = "system-ui, -apple-system, sans-serif";
const APPLE_DESIGNS: Record<string, string> = {
  rounded: "ui-rounded, system-ui, sans-serif", monospaced: "ui-monospace, monospace", serif: "ui-serif, serif",
};

function modifierRole(text: string, at: number): Role | undefined {
  const m = /\.(foregroundColor|foregroundStyle|background|tint|accentColor|fill|stroke|border|listRowBackground)\(\s*$/.exec(
    text.slice(Math.max(0, at - 40), at),
  );
  if (!m) return undefined;
  if (m[1].startsWith("foreground")) return "text";
  if (m[1] === "stroke" || m[1] === "border") return "border";
  if (m[1] === "tint" || m[1] === "accentColor") return "accent";
  return "background";
}

function readApple(entries: Entries, bag: Bag) {
  const sets = new Map<string, string>();
  for (const [path, text] of entries) {
    const m = /(?:^|\/)([^/]+)\.colorset\/Contents\.json$/.exec(path);
    if (!m) continue;
    const css = colorset(text);
    if (!css) continue;
    sets.set(m[1], css);
    bag.colours.add(css, m[1], roleOf(m[1]));
  }

  for (const [path, raw] of entries) {
    if (!path.endsWith(".swift")) continue;
    const text = uncomment(raw);
    if (/^\s*import\s+SwiftUI\b/m.test(text)) bag.platforms.add("swiftui");
    if (/^\s*import\s+UIKit\b/m.test(text)) bag.platforms.add("uikit");
    const add = (css: string | null, at: number, fallback?: string) => {
      const key = keyBefore(text, at);
      const name = key && !/^(Color|UIColor|NSColor|color)$/.test(key) ? key : fallback;
      bag.colours.add(css, name, modifierRole(text, at) ?? roleOf(key));
    };

    for (const c of text.matchAll(
      /\b(?:Color|UIColor|NSColor)\s*\(\s*(?:\.sRGB\s*,\s*)?red:\s*([\d.\s/]+?)[fF]?\s*,\s*green:\s*([\d.\s/]+?)[fF]?\s*,\s*blue:\s*([\d.\s/]+?)[fF]?\s*(?:,\s*(?:alpha|opacity):\s*([\d.\s/]+?)[fF]?\s*)?\)/g,
    )) add(fromChannels([c[1], c[2], c[3], c[4]]), c.index ?? 0);
    for (const c of text.matchAll(/\b(?:Color|UIColor|NSColor)\s*\(\s*hex(?:String)?:\s*(?:"#?([0-9a-fA-F]{3,8})"|0x([0-9a-fA-F]{6}))/g)) {
      add(colour(`#${c[1] ?? c[2]}`), c.index ?? 0);
    }
    for (const c of text.matchAll(/\b(?:Color|UIColor)\s*\(\s*(?:named:\s*)?"([^"]+)"/g)) {
      if (sets.has(c[1])) bag.colours.add(sets.get(c[1]), c[1], modifierRole(text, c.index ?? 0) ?? roleOf(c[1]));
    }
    for (const c of text.matchAll(/\b(Color|UIColor)\.(?:system)?([A-Za-z]\w*)\b(?:\.opacity\(([\d.]+)\))?/g)) {
      const key = c[2][0].toLowerCase() + c[2].slice(1);
      const base = APPLE_COLOURS[key];
      if (base) add(c[3] ? withAlpha(base, Number(c[3])) : base, c.index ?? 0, `${c[1]}.${c[2]}`);
    }
    for (const c of text.matchAll(/\.(foregroundColor|foregroundStyle|background|tint|accentColor|fill|stroke)\(\s*\.(\w+)\s*(?:\.opacity\(([\d.]+)\))?\)/g)) {
      const base = APPLE_COLOURS[c[2]];
      const at = (c.index ?? 0) + c[0].indexOf("(") + 1;
      if (base) bag.colours.add(c[3] ? withAlpha(base, Number(c[3])) : base, `.${c[2]}`, modifierRole(text, at));
    }

    for (const r of text.matchAll(/\bcornerRadius\s*[:=(]\s*([\d.]+)/g)) bag.radii.add(px(r[1]), "cornerRadius");
    const capsules = text.match(/\bCapsule\s*\(/g)?.length ?? 0;
    if (capsules) bag.radii.add("9999px", "Capsule", undefined, capsules);

    for (const f of text.matchAll(/\.system\(\s*size:\s*([\d.]+)(?:\s*,\s*weight:\s*\.(\w+))?(?:\s*,\s*design:\s*\.(\w+))?/g)) {
      bag.type.add(px(f[1]), ".system");
      if (f[2] && APPLE_WEIGHTS[f[2]]) bag.type.add(weight(APPLE_WEIGHTS[f[2]]), `.${f[2]}`);
      bag.fonts.add(APPLE_DESIGNS[f[3] ?? ""] ?? SYSTEM_FONT, ".system");
    }
    for (const f of text.matchAll(/\.custom\(\s*"([^"]+)"\s*,\s*(?:size|fixedSize):\s*([\d.]+)/g)) {
      bag.fonts.add(fontStack(fontName(f[1])), f[1]);
      bag.type.add(px(f[2]), ".custom");
    }
    for (const f of text.matchAll(/UIFont\s*\(\s*name:\s*"([^"]+)"\s*,\s*size:\s*([\d.]+)/g)) {
      bag.fonts.add(fontStack(fontName(f[1])), f[1]);
      bag.type.add(px(f[2]), "UIFont");
    }
    for (const f of text.matchAll(/\b(bold)?[sS]ystemFont\(ofSize:\s*([\d.]+)(?:\s*,\s*weight:\s*\.(\w+))?/g)) {
      bag.fonts.add(SYSTEM_FONT, "systemFont");
      bag.type.add(px(f[2]), "systemFont");
      const w = f[1] ? 700 : APPLE_WEIGHTS[f[3] ?? ""];
      if (w) bag.type.add(weight(w), f[1] ? "boldSystemFont" : `.${f[3]}`);
    }
    for (const f of text.matchAll(/\.font\(\s*\.(largeTitle|title3|title2|title|headline|subheadline|body|callout|footnote|caption2|caption)\b/g)) {
      const [size, w] = APPLE_TEXT[f[1]];
      bag.fonts.add(SYSTEM_FONT, ".system");
      bag.type.add(`${size}px`, `.${f[1]}`);
      if (w !== 400) bag.type.add(weight(w), `.${f[1]}`);
    }
    for (const f of text.matchAll(/\.fontWeight\(\s*\.(\w+)\s*\)/g)) {
      if (APPLE_WEIGHTS[f[1]]) bag.type.add(weight(APPLE_WEIGHTS[f[1]]), `.${f[1]}`);
    }

    for (const s of text.matchAll(/\.shadow\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      const args = s[1];
      const radius = /radius:\s*([\d.]+)/.exec(args)?.[1];
      if (!radius) continue;
      const x = /\bx:\s*(-?[\d.]+)/.exec(args)?.[1] ?? "0";
      const y = /\by:\s*(-?[\d.]+)/.exec(args)?.[1] ?? "0";
      const tint = /color:\s*(?:Color)?\.(\w+)(?:\.opacity\(([\d.]+)\))?/.exec(args);
      const base = tint ? APPLE_COLOURS[tint[1]] ?? "#000000" : "#000000";
      const c = tint?.[2] ? withAlpha(base, Number(tint[2])) : tint ? base : "rgba(0, 0, 0, 0.33)";
      bag.shadows.add(`${px(x)} ${px(y)} ${px(radius)} ${c}`, ".shadow");
    }

    for (const p of text.matchAll(/\.padding\(\s*(?:\.\w+\s*,\s*)?([\d.]+)?\s*\)/g)) {
      bag.spacing.add(p[1] ? px(p[1]) : "16px", ".padding");
    }
    for (const p of text.matchAll(/\b[VHZ]Stack\s*\([^()]*spacing:\s*([\d.]+)/g)) bag.spacing.add(px(p[1]), "spacing");
  }
}

/** An asset catalog colour set's light, universal colour, as CSS. */
function colorset(text: string): string | null {
  let json: { colors?: { color?: { components?: Record<string, string | number> }; appearances?: unknown[] }[] };
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const entry = json.colors?.find((c) => !c.appearances?.length) ?? json.colors?.[0];
  const comp = entry?.color?.components;
  if (!comp) return null;
  // Xcode writes floats ("0.157"), hex bytes ("0x28") or integers ("40").
  const read = (v: string | number | undefined): number | null => {
    if (v === undefined) return null;
    const s = String(v).trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) / 255;
    const n = Number(s);
    if (Number.isNaN(n)) return null;
    return n > 1 ? n / 255 : n;
  };
  const [r, g, b] = [comp.red, comp.green, comp.blue].map(read);
  const a = read(comp.alpha) ?? 1;
  if (r === null || g === null || b === null) return null;
  return rgba(r * 255, g * 255, b * 255, a);
}

// ---------------------------------------------------------------- android

const COMPOSE_COLOURS: Record<string, string> = {
  White: "#ffffff", Black: "#000000", Red: "#ff0000", Green: "#00ff00", Blue: "#0000ff",
  Yellow: "#ffff00", Cyan: "#00ffff", Magenta: "#ff00ff", Gray: "#888888", LightGray: "#cccccc",
  DarkGray: "#444444", Transparent: "transparent",
};
const COMPOSE_WEIGHTS: Record<string, number> = {
  Thin: 100, ExtraLight: 200, Light: 300, Normal: 400, Medium: 500, SemiBold: 600, Bold: 700,
  ExtraBold: 800, Black: 900,
};
const GENERIC_FONTS: Record<string, string> = {
  SansSerif: "sans-serif", Serif: "serif", Monospace: "monospace", Cursive: "cursive", Default: "sans-serif",
};

function androidRole(attr: string): Role | undefined {
  if (/textColor|hintColor|TextColor/.test(attr)) return "text";
  if (/stroke|border|divider|outline/i.test(attr)) return "border";
  if (/background|windowBackground|cardBackground/i.test(attr)) return "background";
  if (/tint|accent|primary|secondary/i.test(attr)) return "accent";
  return roleOf(attr);
}

function readAndroid(entries: Entries, bag: Bag) {
  const values = entries.filter(([p]) => /(^|\/)res\/values(-(?!night)[\w-]+)?\/[^/]+\.xml$/.test(p));
  const colors = new Map<string, string>();
  const dimens = new Map<string, string>();
  for (const [, text] of values) {
    for (const m of text.matchAll(/<color\s+name="([\w.]+)"[^>]*>\s*([^<\s]+)\s*<\/color>/g)) {
      const css = argb(m[2]) ?? (m[2].startsWith("@color/") ? colors.get(m[2].slice(7)) : undefined);
      if (css && !colors.has(m[1])) colors.set(m[1], css);
    }
    for (const m of text.matchAll(/<dimen\s+name="([\w.]+)"[^>]*>\s*([^<\s]+)\s*<\/dimen>/g)) {
      if (!dimens.has(m[1])) dimens.set(m[1], m[2]);
    }
  }
  const colourOf = (v: string) =>
    v.startsWith("@color/") ? colors.get(v.slice(7)) ?? null : v.startsWith("#") ? argb(v) : null;
  const dimenOf = (v: string) => (v.startsWith("@dimen/") ? dimens.get(v.slice(7)) ?? null : v);

  for (const [name, css] of colors) bag.colours.add(css, name, roleOf(name));
  for (const [name, v] of dimens) measure(name, v, name, bag);
  const named = new Map<string, string>();
  const schemes: string[] = [];

  for (const [path, text] of entries) {
    if (/(^|\/)res\/[\w-]+\/[^/]+\.xml$/.test(path) && !/(^|\/)res\/[\w-]*night/.test(path)) {
      bag.platforms.add("android-xml");
      for (const m of text.matchAll(/<item\s+name="([\w:.]+)"[^>]*>\s*([^<]+?)\s*<\/item>/g)) {
        const attr = m[1].replace(/^android:/, "");
        const css = colourOf(m[2]);
        if (css) bag.colours.add(css, attr, androidRole(attr));
        else measure(attr, dimenOf(m[2]) ?? m[2], attr, bag);
      }
      for (const m of text.matchAll(/\b(?:android|app):(\w+)="([^"]*)"/g)) {
        const [, attr, value] = m;
        const css = colourOf(value);
        if (css) bag.colours.add(css, value.startsWith("@color/") ? value.slice(7) : attr, androidRole(attr));
        else measure(attr, dimenOf(value) ?? value, value.startsWith("@dimen/") ? value.slice(7) : attr, bag);
      }
    } else if (/\.(kt|java)$/.test(path)) {
      for (const m of text.matchAll(/\bR\.color\.(\w+)/g)) {
        if (colors.has(m[1])) bag.colours.add(colors.get(m[1]), m[1], roleOf(m[1]));
      }
      if (path.endsWith(".kt") && /androidx\.compose/.test(text)) readCompose(uncomment(text), named, schemes, bag);
    }
  }
  // A scheme names colours declared anywhere in the module, so it is read last.
  for (const body of schemes) {
    for (const pair of body.matchAll(/(\w+)\s*=\s*(\w+)\s*(?=[,)]|$)/g)) {
      if (named.has(pair[2])) bag.colours.add(named.get(pair[2]), pair[1], roleOf(pair[1]));
    }
  }
}

/** An Android dimension or attribute by what its name says it is. */
function measure(attr: string, value: string, name: string, bag: Bag) {
  if (/fontFamily/i.test(attr)) {
    const font = /^@font\/(\w+)$/.exec(value)?.[1];
    if (font) bag.fonts.add(fontStack(fontName(font)), name);
    else if (/^(sans-serif|serif|monospace)/.test(value)) bag.fonts.add(value.replace(/-(medium|light|thin|condensed|black)$/, ""), name);
    return;
  }
  if (/textStyle/.test(attr) && /bold/.test(value)) {
    bag.type.add(weight(700), name);
    return;
  }
  const len = /^-?\d*\.?\d+(dp|dip|sp|px)$/.test(value) ? px(value.replace(/dip$/, "dp")) : null;
  if (!len) return;
  if (/radius|corner/i.test(attr)) bag.radii.add(len, name);
  else if (/elevation/i.test(attr)) bag.shadows.add(elevationShadow(Number(len.slice(0, -2))), name);
  else if (/textSize|text_size|font_?size|fontSize/i.test(attr)) bag.type.add(len, name);
  else if (/padding|margin|spacing|gap|gutter/i.test(attr) && len !== "0px" && !len.startsWith("-")) bag.spacing.add(len, name);
}

function readCompose(text: string, named: Map<string, string>, schemes: string[], bag: Bag) {
  bag.platforms.add("compose");
  const add = (css: string | null, at: number, fallback?: string) => {
    const key = keyBefore(text, at);
    if (css && key && !named.has(key)) named.set(key, css);
    bag.colours.add(css, key && key !== "color" ? key : fallback, roleOf(key));
  };
  for (const m of text.matchAll(/\bColor\(\s*0x([0-9a-fA-F]{8})\s*\)/g)) add(argb(m[1]), m.index ?? 0);
  for (const m of text.matchAll(
    /\bColor\(\s*(?:red\s*=\s*)?(\d*\.?\d+)([fF]?)\s*,\s*(?:green\s*=\s*)?(\d*\.?\d+)[fF]?\s*,\s*(?:blue\s*=\s*)?(\d*\.?\d+)[fF]?\s*(?:,\s*(?:alpha\s*=\s*)?(\d*\.?\d+)[fF]?\s*)?\)/g,
  )) {
    const floats = /\./.test(m[1] + m[3] + m[4]) || m[2] !== "";
    add(fromChannels([m[1], m[3], m[4], m[5]], !floats), m.index ?? 0);
  }
  for (const m of text.matchAll(/\bColor\.(\w+)\b(?!\s*\()/g)) {
    if (COMPOSE_COLOURS[m[1]]) add(COMPOSE_COLOURS[m[1]], m.index ?? 0, `Color.${m[1]}`);
  }
  for (const m of text.matchAll(/\blightColorScheme\s*\(/g)) {
    schemes.push(balanced(text, (m.index ?? 0) + m[0].length - 1));
  }

  for (const m of text.matchAll(/\bRoundedCornerShape\(\s*(?:(?:size|corner)\s*=\s*)?([\d.]+)\.dp/g)) bag.radii.add(px(m[1]), "RoundedCornerShape");
  for (const m of text.matchAll(/\bRoundedCornerShape\(\s*(?:percent\s*=\s*)?50\s*\)|\bCircleShape\b/g)) {
    bag.radii.add("9999px", m[0].startsWith("Circle") ? "CircleShape" : "RoundedCornerShape(50)");
  }
  for (const m of text.matchAll(/\bfontSize\s*=\s*([\d.]+)\.sp/g)) bag.type.add(px(m[1]), "fontSize");
  for (const m of text.matchAll(/\bFontWeight\.(W\d00|\w+)/g)) {
    const w = /^W(\d00)$/.exec(m[1])?.[1] ?? COMPOSE_WEIGHTS[m[1]];
    if (w) bag.type.add(weight(w), `FontWeight.${m[1]}`);
  }
  for (const m of text.matchAll(/\bFont\(\s*(?:resId\s*=\s*)?R\.font\.(\w+)/g)) bag.fonts.add(fontStack(fontName(m[1])), `R.font.${m[1]}`);
  for (const m of text.matchAll(/\bFontFamily\.(SansSerif|Serif|Monospace|Cursive|Default)\b/g)) {
    bag.fonts.add(GENERIC_FONTS[m[1]], `FontFamily.${m[1]}`);
  }
  for (const m of text.matchAll(/\.padding\(([^()]*)\)|\bspacedBy\(([^()]*)\)/g)) {
    for (const d of (m[1] ?? m[2]).matchAll(/([\d.]+)\.dp/g)) {
      if (Number(d[1]) > 0) bag.spacing.add(px(d[1]), m[1] !== undefined ? "padding" : "spacedBy");
    }
  }
  for (const m of text.matchAll(/\b(?:elevation|shadowElevation|defaultElevation)\s*=\s*([\d.]+)\.dp|\.shadow\(\s*(?:elevation\s*=\s*)?([\d.]+)\.dp/g)) {
    const dp = Number(m[1] ?? m[2]);
    if (dp > 0) bag.shadows.add(elevationShadow(dp), `elevation ${fmt(dp)}dp`);
  }
}

// ---------------------------------------------------------------- flutter

/** Material's primary (500) swatches, and grey's shades. */
const MATERIAL: Record<string, string> = {
  red: "#f44336", pink: "#e91e63", purple: "#9c27b0", deepPurple: "#673ab7", indigo: "#3f51b5",
  blue: "#2196f3", lightBlue: "#03a9f4", cyan: "#00bcd4", teal: "#009688", green: "#4caf50",
  lightGreen: "#8bc34a", lime: "#cddc39", yellow: "#ffeb3b", amber: "#ffc107", orange: "#ff9800",
  deepOrange: "#ff5722", brown: "#795548", grey: "#9e9e9e", blueGrey: "#607d8b",
  white: "#ffffff", black: "#000000", transparent: "transparent",
};
const MATERIAL_GREY: Record<string, string> = {
  "50": "#fafafa", "100": "#f5f5f5", "200": "#eeeeee", "300": "#e0e0e0", "400": "#bdbdbd",
  "500": "#9e9e9e", "600": "#757575", "700": "#616161", "800": "#424242", "900": "#212121",
};
const DART_WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };

function materialColour(name: string, shade?: string): string | null {
  const alpha = /^(black|white)(\d{2})$/.exec(name);
  if (alpha) return withAlpha(MATERIAL[alpha[1]], Number(alpha[2]) / 100);
  if (!shade || shade === "500") return MATERIAL[name] ?? null;
  return name === "grey" ? MATERIAL_GREY[shade] ?? null : null;
}

function readFlutter(entries: Entries, bag: Bag) {
  for (const [path, text] of entries) {
    if (/(^|\/)pubspec\.yaml$/.test(path)) {
      for (const m of text.matchAll(/^\s*-\s*family:\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)) bag.fonts.add(fontStack(m[1]), "pubspec.yaml");
      continue;
    }
    if (!path.endsWith(".dart")) continue;
    const code = uncomment(text);
    if (/package:flutter\//.test(code)) bag.platforms.add("flutter");
    const add = (css: string | null, at: number, fallback?: string) => {
      const key = keyBefore(code, at);
      bag.colours.add(css, key && key !== "color" ? key : fallback, roleOf(key));
    };
    for (const m of code.matchAll(/\bColor\(\s*0x([0-9a-fA-F]{8})\s*\)/g)) add(argb(m[1]), m.index ?? 0);
    for (const m of code.matchAll(/\bColor\.fromARGB\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
      add(rgba(+m[2], +m[3], +m[4], +m[1] / 255), m.index ?? 0);
    }
    for (const m of code.matchAll(/\bColor\.fromRGBO\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g)) {
      add(rgba(+m[1], +m[2], +m[3], +m[4]), m.index ?? 0);
    }
    for (const m of code.matchAll(/\bColors\.(\w+?)(?:\.shade(\d+)|\[(\d+)\])?(?:\.withOpacity\(([\d.]+)\)|\.withValues\(alpha:\s*([\d.]+)\))?(?![\w[])/g)) {
      const base = materialColour(m[1], m[2] ?? m[3]);
      const alpha = m[4] ?? m[5];
      if (base) add(alpha ? withAlpha(base, Number(alpha)) : base, m.index ?? 0, `Colors.${m[1]}${m[2] ? `.shade${m[2]}` : m[3] ? `[${m[3]}]` : ""}`);
    }

    for (const m of code.matchAll(/\b(?:BorderRadius|Radius)\.circular\(\s*([\d.]+)\s*\)/g)) bag.radii.add(px(m[1]), "BorderRadius.circular");
    const stadiums = code.match(/\bStadiumBorder\s*\(/g)?.length ?? 0;
    if (stadiums) bag.radii.add("9999px", "StadiumBorder", undefined, stadiums);
    for (const m of code.matchAll(/\bfontFamily:\s*['"]([^'"]+)['"]/g)) bag.fonts.add(fontStack(m[1]), "fontFamily");
    for (const m of code.matchAll(/\bGoogleFonts\.(\w+)\(/g)) {
      if (!/TextTheme$|^getFont$|^config$/.test(m[1])) bag.fonts.add(fontStack(fontName(m[1])), "google_fonts");
    }
    for (const m of code.matchAll(/\bfontSize:\s*([\d.]+)/g)) bag.type.add(px(m[1]), "fontSize");
    for (const m of code.matchAll(/\bFontWeight\.(w\d00|bold|normal)\b/g)) {
      const w = /^w(\d00)$/.exec(m[1])?.[1] ?? DART_WEIGHTS[m[1]];
      bag.type.add(weight(w), `FontWeight.${m[1]}`);
    }
    for (const m of code.matchAll(/\bEdgeInsets(?:Directional)?\.(all|symmetric|only|fromLTRB|fromSTEB)\(([^()]*)\)/g)) {
      for (const n of m[2].matchAll(/(?<![\w.])(\d+(?:\.\d+)?)/g)) {
        if (Number(n[1]) > 0) bag.spacing.add(px(n[1]), `EdgeInsets.${m[1]}`);
      }
    }
    for (const m of code.matchAll(/\bBoxShadow\s*\(/g)) {
      const args = balanced(code, (m.index ?? 0) + m[0].length - 1);
      const blur = /blurRadius:\s*([\d.]+)/.exec(args)?.[1] ?? "0";
      const spread = /spreadRadius:\s*(-?[\d.]+)/.exec(args)?.[1];
      const offset = /Offset\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(args);
      const hex = /Color\(\s*0x([0-9a-fA-F]{8})\s*\)/.exec(args)?.[1];
      const mat = /Colors\.(\w+?)(?:\.withOpacity\(([\d.]+)\)|\.withValues\(alpha:\s*([\d.]+)\))?(?![\w[])/.exec(args);
      const matBase = mat ? materialColour(mat[1]) : null;
      const c =
        (hex && argb(hex)) ||
        (matBase && (mat![2] ?? mat![3] ? withAlpha(matBase, Number(mat![2] ?? mat![3])) : matBase)) ||
        "#000000";
      const parts = [px(offset?.[1] ?? "0"), px(offset?.[2] ?? "0"), px(blur), ...(spread ? [px(spread)] : []), c];
      bag.shadows.add(parts.join(" "), "BoxShadow");
    }
    for (const m of code.matchAll(/\belevation:\s*([\d.]+)/g)) {
      if (Number(m[1]) > 0) bag.shadows.add(elevationShadow(Number(m[1])), `elevation ${m[1]}`);
    }
  }
}

// ---------------------------------------------------------------- description

const PLATFORM_NAMES: Partial<Record<string, string>> = {
  "react-native": "React Native", swiftui: "SwiftUI", uikit: "UIKit", "android-xml": "Android XML",
  compose: "Jetpack Compose", flutter: "Flutter",
};
const SQUARE_WEB = "square — no border-radius in any style sheet or class; draw corners at 0";
const SQUARE_NATIVE = "square — no corner radius anywhere; draw corners at 0";

type Line = { label: string; items: string[]; separator: string; keep: number; priority: number };

/**
 * The look as reference lines, CSS throughout, most useful first. Within
 * `budget`, the least useful items go first — spacing, then type, component
 * rules, shadows — and the palette, corners and fonts always keep at least one.
 */
export function describeLook(look: Look, budget: number): string {
  const content =
    look.colours.length + look.radii.length + look.shadows.length + look.fonts.length +
    look.type.length + look.spacing.length + look.components.length;
  if (!look.platforms.length && !content) return "";

  const measure = (m: Measure) => `${m.css} (${m.name ? `${m.name}, ` : ""}${m.count}×)`;
  const native = look.platforms.map((p) => PLATFORM_NAMES[p]).filter((n): n is string => !!n);
  const radii = look.radii.filter((r) => r.css !== "0px" && r.css !== "0");
  const shadows = look.shadows.filter((s) => s.css !== "none");
  const lines: Line[] = [];
  if (native.length) {
    lines.push({ label: "Platform", items: [`${native.join(", ")} (translated to CSS)`], separator: "", keep: 1, priority: 9 });
  }
  lines.push({
    label: "Palette",
    items: look.colours.slice(0, 12).map((s) =>
      `${s.css} (${s.name ? `${s.name}, ` : ""}${s.count}×${s.role ? ` ${s.role}` : ""})`,
    ),
    separator: ", ", keep: 1, priority: 8,
  });
  if (radii.length || look.platforms.length) {
    lines.push({
      label: "Corners",
      items: radii.length
        ? look.radii.slice(0, 6).map(measure)
        : [native.length ? SQUARE_NATIVE : SQUARE_WEB],
      separator: ", ", keep: 1, priority: 7,
    });
  }
  if (shadows.length || look.platforms.length) {
    lines.push({
      label: "Shadows",
      items: shadows.length ? shadows.slice(0, 4).map(measure) : ["none anywhere — draw flat"],
      separator: "; ", keep: 0, priority: 4,
    });
  }
  lines.push({ label: "Fonts", items: look.fonts.slice(0, 4).map(measure), separator: "; ", keep: 1, priority: 6 });
  lines.push({ label: "Type", items: look.type.slice(0, 8).map(measure), separator: ", ", keep: 0, priority: 2 });
  lines.push({ label: "Spacing", items: look.spacing.slice(0, 8).map(measure), separator: ", ", keep: 0, priority: 1 });
  // Kept to two at least: the base control and one variant are what a mockup
  // copies most directly.
  lines.push({ label: "Component styles", items: [...look.components], separator: "; ", keep: 2, priority: 5 });

  const render = () =>
    lines
      .filter((l) => l.items.length)
      .map((l) => `${l.label}: ${l.items.join(l.separator)}`)
      .join("\n");
  let text = render();
  const byPriority = [...lines].sort((a, b) => a.priority - b.priority);
  while (text.length > budget) {
    const line = byPriority.find((l) => l.items.length > l.keep);
    if (!line) break;
    line.items.pop();
    text = render();
  }
  if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
  return text;
}
