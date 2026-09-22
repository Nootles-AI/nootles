/**
 * A source file as its node in the graph: what it pulls in, what it offers,
 * and what it says about itself.
 *
 * Scanned, not parsed. A real parser per language is a dependency per language
 * and a runtime we have not proven Convex loads; the spike's edges came almost
 * entirely from import lines and `api.x.y` references, which a careful scan
 * finds as well. The scan blanks comments first so that an import someone
 * commented out is not an edge.
 */

export type ParsedFile = {
  path: string;
  language: string;
  lines: number;
  imports: string[];
  exports: string[];
  leading: string;
  convexRefs: string[];
  cssTokens: { name: string; value: string }[];
};

const MAX_EXPORTS = 40;
const MAX_LEADING = 300;
const MAX_TOKENS = 200;

const LANGUAGES: Record<string, string> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx",
  py: "py", go: "go", rs: "rs", java: "java", kt: "kt", swift: "swift", rb: "rb",
  php: "php", cs: "cs", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", scala: "scala",
  vue: "vue", svelte: "svelte", css: "css", scss: "scss", sass: "sass", less: "less",
  styl: "styl", html: "html", md: "md", mdx: "mdx", json: "json", yaml: "yaml",
  yml: "yaml", toml: "toml", sql: "sql", graphql: "graphql", gql: "graphql",
  prisma: "prisma", sh: "sh", kts: "kt", dart: "dart", xml: "xml",
};

export const SCRIPT_LANGUAGES = new Set(["ts", "tsx", "js", "jsx", "vue", "svelte"]);
export const STYLE_LANGUAGES = new Set(["css", "scss", "sass", "less", "styl"]);

export function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "other";
  return LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? "other";
}

export function parseFile(path: string, text: string): ParsedFile {
  const language = languageOf(path);
  const parsed: ParsedFile = {
    path,
    language,
    lines: countLines(text),
    imports: [],
    exports: [],
    leading: "",
    convexRefs: [],
    cssTokens: [],
  };

  if (SCRIPT_LANGUAGES.has(language)) {
    const source = language === "vue" || language === "svelte" ? scriptBlocks(text) : text;
    const code = blankScript(source);
    parsed.imports = scriptImports(code);
    parsed.exports = scriptExports(code);
    parsed.convexRefs = convexRefs(code);
    parsed.leading = leadingComment(source, "slash");
  } else if (language === "py") {
    const code = blankPython(text);
    parsed.imports = pythonImports(code);
    parsed.exports = matchAll(code, /^(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z]\w*)/gm);
    parsed.leading = pythonDocstring(text) || leadingComment(text, "hash");
  } else if (language === "go") {
    const code = blankC(text, { backtick: true });
    parsed.imports = goImports(code);
    parsed.exports = matchAll(code, /^(?:func|type)[ \t]+([A-Z]\w*)/gm);
    parsed.leading = leadingComment(text, "slash");
  } else if (language === "rs") {
    const code = blankC(text, { backtick: false });
    parsed.imports = rustImports(code);
    parsed.exports = matchAll(code, /^[ \t]*pub[ \t]+(?:async[ \t]+)?(?:unsafe[ \t]+)?(?:fn|struct|enum|trait|type)[ \t]+(\w+)/gm);
    parsed.leading = leadingComment(text, "slash");
  } else if (STYLE_LANGUAGES.has(language)) {
    const code = blankStyle(text, language !== "css");
    parsed.imports = styleImports(code);
    parsed.cssTokens = cssTokens(code);
    parsed.leading = leadingComment(text, "slash");
  } else if (language === "md" || language === "mdx") {
    parsed.leading = markdownOpening(text);
  } else if (["java", "kt", "swift", "dart"].includes(language)) {
    parsed.imports = nativeImports(blankC(text, { backtick: false }), language);
    parsed.leading = leadingComment(text, "slash");
  } else if (["php", "cs", "c", "cpp", "scala"].includes(language)) {
    parsed.leading = leadingComment(text, "slash");
  } else if (["sh", "yaml", "toml", "rb"].includes(language)) {
    parsed.leading = leadingComment(text, "hash");
  }

  parsed.imports = unique(parsed.imports);
  parsed.exports = unique(parsed.exports).slice(0, MAX_EXPORTS);
  parsed.convexRefs = unique(parsed.convexRefs);
  return parsed;
}

function countLines(text: string): number {
  if (!text) return 0;
  const breaks = text.split("\n").length;
  return text.endsWith("\n") ? breaks - 1 : breaks;
}

// ---------------------------------------------------------------- blanking

/**
 * Comments become spaces and quoted strings stay, since an import specifier is
 * a string — but where the strings lie is kept too, so a match that starts
 * inside one is not code. Template literal text is blanked (it is prose or
 * markup) while its `${}` holes are scanned as code. Regex literals are skipped
 * so a quote inside one does not open a string. The result is the same length
 * as the input, newlines included, so line-anchored patterns still work.
 */
type Scanned = { text: string; quoted: Uint8Array };

function blankScript(text: string): Scanned {
  const out: string[] = [];
  const quoted = new Uint8Array(text.length);
  const holes: ("brace" | "template")[] = [];
  let i = 0;
  let last = "";
  const n = text.length;

  const template = () => {
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        out.push("  ");
        i += 2;
      } else if (c === "`") {
        out.push(" ");
        i++;
        last = "`";
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        out.push("  ");
        i += 2;
        holes.push("template");
        last = "{";
        return;
      } else {
        out.push(c === "\n" ? "\n" : " ");
        i++;
      }
    }
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) out.push(text[i] === "\n" ? "\n" : " ");
    } else if (c === '"' || c === "'") {
      const start = i++;
      while (i < n && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, n);
      out.push(text.slice(start, i));
      quoted.fill(1, start, i);
      last = c;
    } else if (c === "`") {
      out.push(" ");
      i++;
      template();
    } else if (c === "/" && regexMayStart(last)) {
      const start = i++;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        const r = text[i];
        if (r === "\\") i++;
        else if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        i++;
      }
      i++;
      for (let k = start; k < i && k < n; k++) out.push(text[k] === "\n" ? "\n" : " ");
      last = "/";
    } else {
      if (c === "{") holes.push("brace");
      if (c === "}" && holes.pop() === "template") {
        out.push(" ");
        i++;
        template();
        continue;
      }
      out.push(c);
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return { text: out.join(""), quoted };
}

function live(code: Scanned, m: RegExpMatchArray): boolean {
  return !code.quoted[m.index ?? 0];
}

function regexMayStart(last: string): boolean {
  return last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last);
}

/**
 * Comments out and `"`-strings kept (Go import paths). Single quotes are left
 * alone: a Rust lifetime is an unclosed one.
 */
function blankC(text: string, options: { backtick: boolean }): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\\n])*"|`[^`]*`/g, (match) =>
    match[0] === '"' || (match[0] === "`" && !options.backtick) ? match : blank(match),
  );
}

/** Python imports are not strings, so every string and comment goes. */
function blankPython(text: string): string {
  return text.replace(
    /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*/g,
    blank,
  );
}

function blankStyle(text: string, lineComments: boolean): string {
  const pattern = lineComments
    ? /\/\*[\s\S]*?(?:\*\/|$)|(^|[\s;{}])\/\/[^\n]*/g
    : /\/\*[\s\S]*?(?:\*\/|$)/g;
  return text.replace(pattern, (match, lead: string | undefined) =>
    lead ? lead + blank(match.slice(lead.length)) : blank(match),
  );
}

function blank(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

// ---------------------------------------------------------------- scripts

function scriptBlocks(text: string): string {
  const blocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  return blocks.map((m) => m[1]).join("\n");
}

const SCRIPT_IMPORTS = [
  /(?<![\w$.])import\s+(?:type\s+)?[\w$\s{},*]+?\s*from\s*(["'])([^"'\n]+)\1/g,
  /(?<![\w$.])import\s*(["'])([^"'\n]+)\1/g,
  /(?<![\w$.])export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\1/g,
  /(?<![\w$.])import\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  /(?<![\w$.])require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
];

function scriptImports(code: Scanned): string[] {
  const found: { at: number; spec: string }[] = [];
  for (const pattern of SCRIPT_IMPORTS) {
    for (const m of code.text.matchAll(pattern)) {
      if (live(code, m)) found.push({ at: m.index ?? 0, spec: m[2] });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

function scriptExports(code: Scanned): string[] {
  const found: { at: number; name: string }[] = [];
  const declared =
    /(?<![\w$.])export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|class|const\s+enum|const|let|var|type|interface|enum|namespace)\s*([A-Za-z_$][\w$]*)/g;
  for (const m of code.text.matchAll(declared)) {
    if (live(code, m)) found.push({ at: m.index ?? 0, name: m[1] });
  }
  for (const m of code.text.matchAll(/(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    if (!live(code, m)) continue;
    for (const item of m[1].split(",")) {
      const words = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      const name = (words[1] ?? words[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") {
        found.push({ at: m.index ?? 0, name });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

/** `api.notion.pages.list` → `notion.pages.list`: a module path and a function. */
function convexRefs(code: Scanned): string[] {
  const pattern = /(?<![\w$.])(?:api|internal)((?:\.[A-Za-z_$][\w$]*){2,})/g;
  return [...code.text.matchAll(pattern)].filter((m) => live(code, m)).map((m) => m[1].slice(1));
}

// ---------------------------------------------------------------- python

function pythonImports(code: string): string[] {
  const found: { at: number; spec: string }[] = [];
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm)) {
    for (const part of m[1].split(",")) {
      const spec = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(spec)) found.push({ at: m.index ?? 0, spec });
    }
  }
  const fromImport = /^[ \t]*from[ \t]+(\.+[\w.]*|[\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm;
  for (const m of code.matchAll(fromImport)) {
    const from = m[1];
    if (/^\.+$/.test(from)) {
      // `from . import x` names modules, not a module's members: keep each.
      for (const part of m[2].replace(/[()\\]/g, "").split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^\w+$/.test(name)) found.push({ at: m.index ?? 0, spec: from + name });
      }
    } else {
      found.push({ at: m.index ?? 0, spec: from });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

function pythonDocstring(text: string): string {
  const m = /^(?:\s*#[^\n]*\n)*\s*(?:[rRuU]?)("""|''')([\s\S]*?)\1/.exec(text);
  return m ? collapse(m[2]) : "";
}

// ---------------------------------------------------------------- go, rust

function goImports(code: string): string[] {
  const found: { at: number; spec: string }[] = [];
  for (const m of code.matchAll(/^import[ \t]*\(([\s\S]*?)\)/gm)) {
    for (const line of m[1].matchAll(/(?:[\w.]+[ \t]+)?"([^"]+)"/g)) {
      found.push({ at: (m.index ?? 0) + (line.index ?? 0), spec: line[1] });
    }
  }
  for (const m of code.matchAll(/^import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm)) {
    found.push({ at: m.index ?? 0, spec: m[1] });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

function rustImports(code: string): string[] {
  const found: { at: number; spec: string }[] = [];
  for (const m of code.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm)) {
    found.push({ at: m.index ?? 0, spec: m[1].replace(/\s+/g, " ").trim() });
  }
  for (const m of code.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm)) {
    found.push({ at: m.index ?? 0, spec: `mod ${m[1]}` });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

// ---------------------------------------------------------------- native

/**
 * Module names, not paths: nothing resolves them to files, but they say which
 * UI framework a file draws with — SwiftUI, Compose, Flutter.
 */
function nativeImports(code: string, language: string): string[] {
  const pattern =
    language === "swift"
      ? /^[ \t]*(?:@\w+[ \t]+)*import[ \t]+(?:(?:struct|class|enum|protocol|func|var|let|typealias)[ \t]+)?([\w.]+)/gm
      : language === "dart"
        ? /^[ \t]*(?:import|export)[ \t]+['"]([^'"\n]+)['"]/gm
        : /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.*]+)/gm;
  return matchAll(code, pattern);
}

// ---------------------------------------------------------------- styles

function styleImports(code: string): string[] {
  const pattern = /@(?:import|use|forward)\s+(?:url\(\s*)?(["']?)([^"'()\s;,]+)\1/g;
  return [...code.matchAll(pattern)].map((m) => m[2]).filter((spec) => !/^url$/i.test(spec));
}

function cssTokens(code: string): { name: string; value: string }[] {
  const tokens: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const m of code.matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}]|$)/gm)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    tokens.push({ name: m[1], value: m[2].replace(/\s+/g, " ") });
    if (tokens.length === MAX_TOKENS) break;
  }
  return tokens;
}

// ---------------------------------------------------------------- leading text

const PRAGMA = /^(-\*-|eslint|prettier|@ts-|tslint|jshint|global |@jsx|@flow|@refresh|biome-ignore|istanbul|c8 |#region|region\b)/;
const LEGAL = /copyright|license|spdx/i;

/**
 * The comment a file opens with, past a shebang, directives and license or
 * lint pragmas — the one place a file reliably says what it is for.
 */
function leadingComment(text: string, style: "slash" | "hash"): string {
  let rest = text.replace(/^﻿/, "").replace(/^#![^\n]*\n/, "");
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    const directive = /^(["'])use [\w ]+\1;?/.exec(rest);
    if (directive && style === "slash") {
      rest = rest.slice(directive[0].length);
      continue;
    }
    const block = style === "slash" ? /^\/\*([\s\S]*?)\*\//.exec(rest) : null;
    const lines = (style === "slash" ? /^(?:\/\/[^\n]*(?:\n[ \t]*|$))+/ : /^(?:#[^\n]*(?:\n[ \t]*|$))+/).exec(rest);
    const match = block ?? lines;
    if (!match) return "";
    const body = block ? blockText(block[1]) : lineText(match[0], style);
    rest = rest.slice(match[0].length);
    if (body && !PRAGMA.test(body) && !LEGAL.test(body)) return clip(collapse(body), MAX_LEADING);
  }
}

function blockText(body: string): string {
  const lines = body.split("\n").map((line) => line.replace(/^\s*\*+ ?/, "").replace(/^[*!]\s?/, ""));
  const tag = lines.findIndex((line) => /^\s*@\w/.test(line));
  return (tag > 0 ? lines.slice(0, tag) : tag === 0 ? [] : lines).join(" ").trim();
}

function lineText(body: string, style: "slash" | "hash"): string {
  const marker = style === "slash" ? /^\s*\/\/[/!]?\s?/ : /^\s*#+\s?/;
  return body
    .split("\n")
    .map((line) => line.replace(marker, ""))
    .join(" ")
    .trim();
}

function markdownOpening(text: string): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const prose = paragraphs.find((p) => !/^(#|<|!\[|\||```|import |export )/.test(p));
  return prose ? clip(collapse(prose.replace(/[*_`]/g, "")), MAX_LEADING) : "";
}

// ---------------------------------------------------------------- helpers

function matchAll(code: string, pattern: RegExp): string[] {
  return [...code.matchAll(pattern)].map((m) => m[1]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
