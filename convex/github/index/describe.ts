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
const STYLING_SUMMARY = 2000;

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
  "Colour tokens", "Corners", "Shadows", "Borders", "Font families", "Component styles",
  "Components", "Radius tokens", "Type tokens", "Spacing tokens", "Tailwind",
  "Shadow tokens", "Motion tokens", "Other tokens",
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
  for (const [label, items] of inUse(texts)) add(label, items);
  add("Component styles", componentStyles(texts));
  add("Font families", fontFamilies(sorted, tokens, texts));
  add("Tailwind", tailwindFacts(sorted, texts));
  add("Components", componentNames(sorted));

  const out: string[] = [];
  let budget = STYLING_SUMMARY;
  for (const label of ORDER) {
    const items = lines.get(label);
    if (!items || budget <= label.length + 8) continue;
    const separator =
      label === "Tailwind" ? ". " : label.endsWith("tokens") || label === "Component styles" ? "; " : ", ";
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
  if (label === "Component styles") return 700;
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

// ---------------------------------------------------------------- in use

const STYLE_FILE = /\.(css|scss|sass|less|styl)$/i;
const GUI_FILE = /\.(tsx|jsx|vue|svelte|html)$/i;
/** What a person drawing a screen needs spelled out for a control. */
const CONTROL = /(button|btn|cta|link|input|field|card|chip|tag|badge|tab|pill)/i;
const DECLS_SHOWN = 10;

/**
 * How the code actually styles itself, as opposed to what it declares: the
 * corner radii, shadows and borders its style sheets and Tailwind classes use.
 * A look is as much what is never used as what is — a codebase with no
 * border-radius anywhere is square, and a mockup that is not told so rounds
 * its corners by habit — so absence is said outright.
 */
function inUse(texts: Map<string, string>): [string, string[]][] {
  const radii = new Map<string, number>();
  const shadows = new Map<string, number>();
  const borders = new Map<string, number>();
  let sheets = 0;
  const count = (into: Map<string, number>, value: string) =>
    into.set(value, (into.get(value) ?? 0) + 1);

  for (const [path, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (STYLE_FILE.test(path)) {
      sheets++;
      for (const rule of rules(text)) {
        for (const [prop, value] of rule.decls) {
          if (/^border(-[a-z]+)*-radius$/.test(prop)) count(radii, value);
          else if (prop === "box-shadow") count(shadows, value);
          else if (/^border(-(top|right|bottom|left))?$/.test(prop)) count(borders, value);
        }
      }
    } else if (GUI_FILE.test(path)) {
      for (const cls of classNames(text)) {
        if (/^rounded(-|$)/.test(cls)) count(radii, cls);
        else if (/^shadow(-|$)/.test(cls)) count(shadows, cls);
        else if (/^border(-[0-9]+)?$/.test(cls)) count(borders, cls);
      }
    }
  }
  if (!sheets && !radii.size && !shadows.size) return [];

  const top = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 8)
      .map(([v, n]) => (n > 1 ? `${v} (${n}×)` : v));
  const square = [...radii.keys()].every((v) => /^(0|0px|none|rounded-none)$/.test(v));
  return [
    [
      "Corners",
      square
        ? ["square — no border-radius in any style sheet or class; draw corners at 0"]
        : top(radii),
    ],
    ["Shadows", shadows.size ? top(shadows) : ["none anywhere — draw flat"]],
    ["Borders", top(borders)],
  ];
}

/**
 * The rules that style controls — buttons, links, inputs, cards — verbatim,
 * and for markup styled with utility classes, the classes on those elements.
 * What a primary and a secondary button look like is a fact to copy, not one
 * to infer from a palette.
 */
function componentStyles(texts: Map<string, string>): string[] {
  const found: { text: string; rank: number; at: number }[] = [];
  const utilities: string[] = [];
  for (const [path, text] of [...texts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (STYLE_FILE.test(path)) {
      for (const rule of rules(text)) {
        // One declaration is a tweak, not a look.
        if (!CONTROL.test(rule.selector) || rule.decls.length < 2) continue;
        const decls = rule.decls
          .filter(([p]) => !UNSEEN.test(p))
          .slice(0, DECLS_SHOWN)
          .map(([p, v]) => `${p}: ${v}`)
          .join("; ");
        if (!decls) continue;
        found.push({ text: `${rule.selector} { ${decls} }`, rank: controlRank(rule.selector), at: found.length });
      }
    } else if (GUI_FILE.test(path)) {
      for (const m of text.matchAll(/<(button|a|input|Link)\b[^>]*?class(?:Name)?=["'`{]+([^"'`}]{1,240})/g)) {
        const classes = collapse(m[2]);
        // Only utility classes say how a thing looks; a semantic class name
        // points at a rule, and the rule is listed above.
        const looks = classes.split(" ").filter((c) => UTILITY.test(c.replace(/^[a-z]+:/, "")));
        if (looks.length >= 2) utilities.push(`<${m[1]}> ${classes}`);
      }
    }
  }
  return [
    ...found.sort((a, b) => a.rank - b.rank || a.at - b.at).map((f) => f.text),
    ...utilities,
  ];
}

/** Declarations a still picture cannot show. */
const UNSEEN = /^(transition|animation|cursor|will-change|user-select|pointer-events|outline-offset)/;

const UTILITY = /^(bg|text|px|py|pl|pr|pt|pb|p|m[xytrbl]?|rounded|border|font|shadow|ring|h|w|gap|tracking|leading|uppercase|lowercase)(-|$)/;

/** Buttons first: they are what a mockup draws most, and get wrong most. */
function controlRank(selector: string): number {
  if (/button|btn|cta/i.test(selector)) return 0;
  if (/input|field/i.test(selector)) return 1;
  if (/link/i.test(selector)) return 2;
  return 3;
}

/** Flat rules out of a style sheet: innermost blocks, so nesting and @media are read through. */
function rules(text: string): { selector: string; decls: [string, string][] }[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const out: { selector: string; decls: [string, string][] }[] = [];
  for (const m of clean.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = collapse(m[1]);
    if (!selector || selector.startsWith("@") || /^(from|to|\d+%)/.test(selector)) continue;
    const decls: [string, string][] = [];
    for (const part of m[2].split(";")) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      const prop = part.slice(0, at).trim().toLowerCase();
      const value = collapse(part.slice(at + 1));
      if (prop && value && !prop.startsWith("--")) decls.push([prop, value]);
    }
    out.push({ selector, decls });
  }
  return out;
}

/** Every class a markup file names, from class and className attributes. */
function classNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/class(?:Name)?=["'`{]+([^"'`}]{1,400})/g)) {
    out.push(...m[1].split(/\s+/).map((c) => c.replace(/^[a-z]+:/, "")).filter(Boolean));
  }
  return out;
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
