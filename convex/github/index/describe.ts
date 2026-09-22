import { clip, SCRIPT_LANGUAGES, STYLE_LANGUAGES, type ParsedFile } from "./parse";

/**
 * Stage-0 descriptions: what the scan already knows, set out as text. No model
 * — a file's own leading comment is the best brief it will get for free, and
 * its exports are the next best. A model summary replaces these where
 * attention goes (stage 3).
 */

const BRIEF = 140;
const SUMMARY = 900;
const TERMS = 6000;
const STYLING_SUMMARY = 1500;

const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript React", js: "JavaScript", jsx: "JavaScript React",
  py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", swift: "Swift",
  rb: "Ruby", php: "PHP", cs: "C#", c: "C", cpp: "C++", scala: "Scala", vue: "Vue",
  svelte: "Svelte", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less", styl: "Stylus",
  html: "HTML", md: "Markdown", mdx: "MDX", json: "JSON", yaml: "YAML", toml: "TOML",
  sql: "SQL", graphql: "GraphQL", prisma: "Prisma", sh: "Shell",
};

export function describeFile(
  f: ParsedFile,
  concern: string,
): { brief: string; summary: string; terms: string } {
  const language = LANGUAGE_NAMES[f.language] ?? "Source";
  const brief = f.leading
    ? firstSentence(f.leading)
    : f.exports.length
      ? `Exports ${series(f.exports, 3)}`
      : concern
        ? `${language} file in ${concern}`
        : `${language} file`;

  const facts = `${language}, ${f.lines} ${f.lines === 1 ? "line" : "lines"}`;
  const summary = [
    f.path,
    f.leading,
    f.exports.length ? `Exports: ${f.exports.join(", ")}` : "",
    concern ? `${facts}, in ${concern}.` : `${facts}.`,
  ].filter(Boolean).join("\n");

  const terms = [
    words(f.path).join(" "),
    f.exports.join(" "),
    f.exports.flatMap(words).join(" "),
    f.leading,
  ].filter(Boolean).join("\n");

  return { brief: clip(brief, BRIEF), summary: clip(summary, SUMMARY), terms: terms.slice(0, TERMS) };
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(?=\s|$)/.exec(text);
  return m ? m[1] : text;
}

function series(names: string[], shown: number): string {
  if (names.length === 1) return names[0];
  if (names.length <= shown) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------- styling

type Token = { name: string; value: string };

/**
 * Checked in order, so a name that fits two families lands in the more
 * specific: `--font-size` is type, not spacing, and `--border-radius` is a
 * radius, not a colour.
 */
const FAMILIES: { label: string; test: (t: Token) => boolean }[] = [
  { label: "Radius tokens", test: (t) => /radius|rounded/i.test(t.name) },
  { label: "Type tokens", test: (t) => /font|leading|tracking|line-height|letter|text-(xs|sm|base|md|lg|\d?xl)\b/i.test(t.name) },
  { label: "Shadow tokens", test: (t) => /shadow|elevation/i.test(t.name) },
  { label: "Motion tokens", test: (t) => /duration|ease|transition|motion|animat/i.test(t.name) },
  { label: "Spacing tokens", test: (t) => /space|spacing|gap|pad|margin|gutter|inset|size|width|height/i.test(t.name) },
  {
    label: "Colour tokens",
    test: (t) =>
      /colou?r|bg|background|foreground|fg\b|border|ring|accent|primary|secondary|muted|destructive|surface|fill|stroke|brand|neutral|gr[ae]y|success|warning|danger|error|info|text/i.test(t.name) ||
      /^(#[0-9a-f]{3,8}\b|(rgba?|hsla?|oklch|oklab|lab|lch|color|hwb)\()/i.test(t.value),
  },
  { label: "Other tokens", test: () => true },
];

/** Most useful first, so a long token list cannot crowd out fonts or components. */
const ORDER = [
  "Colour tokens", "Font families", "Components", "Radius tokens", "Type tokens",
  "Spacing tokens", "Tailwind", "Shadow tokens", "Motion tokens", "Other tokens",
];

/**
 * The styling concern as reference lines a designer, or a mockup generator,
 * can build to: token values verbatim, the fonts, the Tailwind theme, and the
 * component names. Facts only.
 */
export function describeStyling(files: ParsedFile[], texts: Map<string, string>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const ranked: { token: Token; score: number; at: number }[] = [];
  const seen = new Set<string>();
  for (const f of sorted) {
    for (const t of f.cssTokens) {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      ranked.push({ token: t, score: usefulness(t, f.path), at: ranked.length });
    }
  }
  const tokens = ranked
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((r) => r.token);

  const lines = new Map<string, string[]>();
  const add = (label: string, items: string[]) => {
    if (items.length) lines.set(label, [...(lines.get(label) ?? []), ...items]);
  };
  for (const t of tokens) {
    add(FAMILIES.find((family) => family.test(t))!.label, [`${t.name}: ${t.value}`]);
  }
  add("Font families", fontFamilies(sorted, tokens, texts));
  add("Tailwind", tailwindFacts(sorted, texts));
  add("Components", componentNames(sorted));

  const out: string[] = [];
  let budget = STYLING_SUMMARY;
  for (const label of ORDER) {
    const items = lines.get(label);
    if (!items || budget <= label.length + 8) continue;
    const separator = label === "Tailwind" ? ". " : label.endsWith("tokens") ? "; " : ", ";
    const line = fit(`${label}: `, [...new Set(items)], separator, Math.min(budget, lineCap(label)));
    if (!line) continue;
    out.push(line);
    budget -= line.length + 1;
  }
  return out.join("\n");
}

/**
 * How much a token tells someone drawing the product. The palette a page is
 * built from — declared at the root of a global sheet, with a literal value
 * and a semantic name — comes first; a component's private variable, an alias
 * of another token, and a vendor's own namespace come last.
 */
function usefulness(t: Token, path: string): number {
  let score = 0;
  if (GLOBAL_SHEET.test(path)) score += 3;
  if (!/^var\(/.test(t.value.trim())) score += 2;
  if (CORE_NAME.test(t.name)) score += 3;
  if (VENDOR.test(t.name)) score -= 5;
  return score;
}

const GLOBAL_SHEET = /(^|\/)(globals?|index|app|main|base|root|theme|tokens|variables|vars)\.(css|scss|sass|less)$/i;
const CORE_NAME =
  /^--(color-)?(background|foreground|surface|elevated|sunken|card|border|input|ring|muted|faint|primary|secondary|accent|brand|danger|destructive|success|warning|info|radius|font|text|ink|paper)(-|$)/i;
const VENDOR = /^--(bn|tw|ov|mantine|chakra|mui|radix|rdp|swiper|toastify|reach)-/i;

function lineCap(label: string): number {
  if (label === "Colour tokens") return 560;
  if (label === "Components") return 360;
  return 300;
}

/** As many items as fit whole, and how many did not. */
function fit(prefix: string, items: string[], separator: string, max: number): string {
  let line = prefix;
  for (let i = 0; i < items.length; i++) {
    const next = (i ? separator : "") + items[i];
    const more = i < items.length - 1 ? ` (+${items.length - i - 1} more)`.length : 0;
    if (line.length + next.length + more > max) {
      return i ? `${line} (+${items.length - i} more)` : "";
    }
    line += next;
  }
  return line;
}

function fontFamilies(files: ParsedFile[], tokens: Token[], texts: Map<string, string>): string[] {
  const found: string[] = [];
  for (const t of tokens) {
    if (/^--font(-family)?(-|$)/.test(t.name) && !/weight|size|feature|variation/.test(t.name)) {
      found.push(t.value);
    }
  }
  for (const f of files) {
    const text = texts.get(f.path);
    if (!text) continue;
    if (STYLE_LANGUAGES.has(f.language)) {
      for (const m of text.matchAll(/font-family\s*:\s*([^;{}]+)/g)) found.push(collapse(m[1]));
    }
    if (isTailwindConfig(f.path)) {
      const block = objectAfter(uncomment(text), /fontFamily\s*:\s*\{/);
      for (const m of block.matchAll(/([\w-]+|"[^"]+"|'[^']+')\s*:\s*\[([^\]]*)\]/g)) {
        found.push(`${m[1].replace(/["']/g, "")}: ${collapse(m[2])}`);
      }
    }
  }
  return found.filter((v) => !/^(inherit|initial|unset)$/.test(v));
}

function tailwindFacts(files: ParsedFile[], texts: Map<string, string>): string[] {
  const facts: string[] = [];
  for (const f of files) {
    const raw = texts.get(f.path);
    if (!raw) continue;
    const text = isTailwindConfig(f.path) ? uncomment(raw) : raw;
    if (isTailwindConfig(f.path)) {
      const theme = objectAfter(text, /\btheme\s*:\s*\{/);
      const own = topLevelKeys(theme).filter((k) => k !== "extend");
      const extended = topLevelKeys(objectAfter(theme, /\bextend\s*:\s*\{/));
      if (own.length) facts.push(`theme in ${f.path} sets ${own.join(", ")}`);
      if (extended.length) facts.push(`theme in ${f.path} extends ${extended.join(", ")}`);
    } else if (STYLE_LANGUAGES.has(f.language) && /@theme\b/.test(text)) {
      facts.push(`v4 @theme in ${f.path}`);
    }
  }
  return facts;
}

function componentNames(files: ParsedFile[]): string[] {
  const names: string[] = [];
  for (const f of files) {
    if (!SCRIPT_LANGUAGES.has(f.language)) continue;
    // Providers and contexts are wiring, not something drawn on a screen.
    const pascal = f.exports.filter(
      (name) =>
        /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name) && !/(Provider|Context)$/.test(name),
    );
    names.push(...pascal);
    if (!pascal.length && (f.language === "vue" || f.language === "svelte")) {
      const base = f.path.slice(f.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
      if (/^[A-Z]/.test(base)) names.push(base);
    }
  }
  return names;
}

function isTailwindConfig(path: string): boolean {
  return /(^|\/)tailwind\.config\.[^/]+$/.test(path);
}

/** The body of the `{…}` the pattern ends on, braces balanced; "" if absent. */
function objectAfter(text: string, pattern: RegExp): string {
  const m = pattern.exec(text);
  if (!m) return "";
  const open = (m.index ?? 0) + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (depth === 0 && (i === 0 || /[\s,]/.test(body[i - 1]))) {
      const m = /^([A-Za-z_$][\w$-]*|"[^"]+"|'[^']+')\s*:/.exec(body.slice(i, i + 80));
      if (m) {
        keys.push(m[1].replace(/["']/g, ""));
        i += m[0].length - 1;
      }
    }
  }
  return [...new Set(keys)];
}

/** Comments out of a config file, sparing the `//` in a URL. */
function uncomment(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
