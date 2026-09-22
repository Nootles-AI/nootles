import type { ParsedFile } from "./parse";
import { isTest } from "./select";

/**
 * Import specifiers turned into edges between files that exist in the repo.
 *
 * Only what can be resolved without a package manager: relative paths, the
 * root tsconfig's aliases, Python modules, Go packages by directory, and
 * Convex's `api.x.y` references. A bare package name resolves to nothing —
 * `react` is not part of the repo, and guessing would draw edges to whatever
 * file happens to share its name.
 */

export type Reference = { from: string; to: string; type: "imports" | "convex" };

type PathConfig = { baseUrl: string; paths: Record<string, string[]> };

export function tsPaths(files: { path: string; text: string }[]): PathConfig | null {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const root = ["tsconfig.json", "jsconfig.json"].find((name) => byPath.has(name));
  if (!root) return null;

  let baseUrl: string | undefined;
  let paths: Record<string, string[]> | undefined;
  let current: string | undefined = root;
  // An `extends` chain within the repo root supplies what the root leaves out.
  for (let hop = 0; current && hop < 4; hop++) {
    const config = readJsonc(byPath.get(current) ?? "");
    const options = (config?.compilerOptions ?? {}) as Record<string, unknown>;
    if (baseUrl === undefined && typeof options.baseUrl === "string") baseUrl = options.baseUrl;
    if (paths === undefined && isPathMap(options.paths)) paths = options.paths;
    const parent: unknown = config?.extends;
    current = (typeof parent === "string" && parent.startsWith(".") && normalise(parent)) || undefined;
    if (current && !byPath.has(current) && byPath.has(`${current}.json`)) current = `${current}.json`;
  }
  return { baseUrl: baseUrl ?? ".", paths: paths ?? {} };
}

export function resolveReferences(files: ParsedFile[], config: PathConfig | null): Reference[] {
  const exists = new Set(files.map((f) => f.path));
  const goPackages = goDirectories(files);
  const convexRoots = [...new Set(files.flatMap((f) => convexRoot(f.path)))].sort();
  const aliases = aliasesOf(config);
  const baseUrl = config && normalise(config.baseUrl);

  const seen = new Set<string>();
  const out: Reference[] = [];
  const add = (from: string, to: string | null, type: Reference["type"]) => {
    if (!to || to === from) return;
    const key = `${from}\n${to}\n${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, type });
  };

  for (const file of files) {
    const dir = dirname(file.path);
    for (const spec of file.imports) {
      if (["ts", "tsx", "js", "jsx", "vue", "svelte", "mdx"].includes(file.language)) {
        add(file.path, script(spec, dir, exists, aliases, baseUrl), "imports");
      } else if (["css", "scss", "sass", "less", "styl"].includes(file.language)) {
        add(file.path, style(spec, dir, exists), "imports");
      } else if (file.language === "py") {
        add(file.path, python(spec, dir, exists), "imports");
      } else if (file.language === "go") {
        for (const to of goPackages.get(goPackage(spec, goPackages, dir)) ?? []) {
          add(file.path, to, "imports");
        }
      }
    }
    for (const ref of file.convexRefs) {
      add(file.path, convexModule(ref, file.path, convexRoots, exists), "convex");
    }
  }
  return out.sort(
    (a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.type, b.type),
  );
}

// ---------------------------------------------------------------- scripts

const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

type Alias = { prefix: string; suffix: string; wildcard: boolean; targets: string[] };

function aliasesOf(config: PathConfig | null): Alias[] {
  if (!config) return [];
  const base = normalise(config.baseUrl) ?? "";
  return Object.keys(config.paths)
    .sort()
    .map((pattern) => {
      const star = pattern.indexOf("*");
      return {
        prefix: star < 0 ? pattern : pattern.slice(0, star),
        suffix: star < 0 ? "" : pattern.slice(star + 1),
        wildcard: star >= 0,
        targets: config.paths[pattern].flatMap((t) => join(base, t) ?? []),
      };
    })
    // TypeScript prefers the pattern with the longest literal prefix.
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

function script(
  spec: string,
  dir: string,
  exists: Set<string>,
  aliases: Alias[],
  baseUrl: string | null,
): string | null {
  const bare = spec.replace(/[?#].*$/, "");
  if (isRelative(bare)) return probeScript(join(dir, bare), exists);
  for (const alias of aliases) {
    const matched = alias.wildcard
      ? bare.startsWith(alias.prefix) && bare.endsWith(alias.suffix) &&
        bare.length >= alias.prefix.length + alias.suffix.length
      : bare === alias.prefix;
    if (!matched) continue;
    const middle = alias.wildcard
      ? bare.slice(alias.prefix.length, bare.length - alias.suffix.length)
      : "";
    for (const target of alias.targets) {
      const hit = probeScript(target.replace("*", middle), exists);
      if (hit) return hit;
    }
  }
  // Only an explicit baseUrl makes bare specifiers repo paths; the default "."
  // would turn `convex/values` into a file of a repo that has a convex/ dir.
  if (baseUrl) return probeScript(join(baseUrl, bare), exists);
  return null;
}

function probeScript(path: string | null, exists: Set<string>): string | null {
  if (path === null) return null;
  if (exists.has(path) && /\.[a-z]+$/i.test(path)) return path;
  // ESM TypeScript imports its siblings by their compiled `.js` names.
  const stem = path.replace(/\.(m|c)?jsx?$/, "");
  for (const candidate of [stem, path]) {
    for (const ext of SCRIPT_EXTENSIONS) if (exists.has(candidate + ext)) return candidate + ext;
    for (const ext of SCRIPT_EXTENSIONS) {
      const index = `${candidate ? `${candidate}/` : ""}index${ext}`;
      if (exists.has(index)) return index;
    }
  }
  for (const ext of [".vue", ".svelte", ".json", ".css"]) {
    if (exists.has(path + ext)) return path + ext;
  }
  return null;
}

// ---------------------------------------------------------------- styles

const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

/** CSS imports are relative to the sheet even without `./`. */
function style(spec: string, dir: string, exists: Set<string>): string | null {
  if (/^([a-z]+:)?\/\//i.test(spec) || spec.startsWith("~")) return null;
  const path = join(dir, spec);
  if (path === null) return null;
  if (exists.has(path)) return path;
  const slash = path.lastIndexOf("/");
  const partial = `${path.slice(0, slash + 1)}_${path.slice(slash + 1)}`;
  for (const stem of [path, partial, `${path}/index`, `${path}/_index`]) {
    for (const ext of STYLE_EXTENSIONS) if (exists.has(stem + ext)) return stem + ext;
  }
  return null;
}

// ---------------------------------------------------------------- python

function python(spec: string, dir: string, exists: Set<string>): string | null {
  const dots = /^\.*/.exec(spec)![0].length;
  const modulePath = spec.slice(dots).replace(/\./g, "/");
  const roots: (string | null)[] = [];
  if (dots > 0) {
    let base: string | null = dir;
    for (let up = 1; up < dots && base !== null; up++) base = parent(base);
    roots.push(base);
  } else {
    roots.push("", "src");
  }
  for (const root of roots) {
    if (root === null) continue;
    const stem = [root, modulePath].filter(Boolean).join("/");
    for (const candidate of [`${stem}.py`, `${stem ? `${stem}/` : ""}__init__.py`]) {
      if (exists.has(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------- go

const GO_FILES_PER_IMPORT = 10;

function goDirectories(files: ParsedFile[]): Map<string, string[]> {
  const dirs = new Map<string, string[]>();
  for (const file of files) {
    if (file.language !== "go" || isTest(file.path)) continue;
    const dir = dirname(file.path);
    dirs.set(dir, [...(dirs.get(dir) ?? []), file.path]);
  }
  for (const [dir, paths] of dirs) dirs.set(dir, paths.sort().slice(0, GO_FILES_PER_IMPORT));
  return dirs;
}

/** A Go import names its module path; the repo directory it ends with is the package. */
function goPackage(spec: string, dirs: Map<string, string[]>, from: string): string {
  let best = "";
  for (const dir of dirs.keys()) {
    if (!dir || dir === from || dir.length <= best.length) continue;
    if (spec === dir || spec.endsWith(`/${dir}`)) best = dir;
  }
  return best;
}

// ---------------------------------------------------------------- convex

function convexRoot(path: string): string[] {
  const segments = path.split("/");
  const at = segments.lastIndexOf("convex", segments.length - 2);
  return at < 0 ? [] : [segments.slice(0, at + 1).join("/")];
}

/**
 * `notion.pages.list` is the function `list` in `convex/notion/pages.ts`. When
 * a repo holds more than one convex/ dir, the one nearest the caller wins.
 */
function convexModule(
  ref: string,
  from: string,
  roots: string[],
  exists: Set<string>,
): string | null {
  const modulePath = ref.split(".").slice(0, -1).join("/");
  const ordered = [...roots].sort(
    (a, b) => sharedPrefix(b, from) - sharedPrefix(a, from) || compare(a, b),
  );
  for (const root of ordered) {
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      if (exists.has(`${root}/${modulePath}${ext}`)) return `${root}/${modulePath}${ext}`;
    }
    for (const ext of [".ts", ".js"]) {
      if (exists.has(`${root}/${modulePath}/index${ext}`)) return `${root}/${modulePath}/index${ext}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- paths & json

function isRelative(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function parent(dir: string): string | null {
  return dir ? dirname(dir) : null;
}

/** Joined and normalised; null when the path climbs out of the repo. */
function join(dir: string, spec: string): string | null {
  return normalise(dir ? `${dir}/${spec}` : spec);
}

function normalise(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") out.push(segment);
    else if (out.pop() === undefined) return null;
  }
  return out.join("/");
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function isPathMap(value: unknown): value is Record<string, string[]> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).every((v) => Array.isArray(v) && v.every((t) => typeof t === "string"))
  );
}

/** JSON with comments and trailing commas, as tsconfig files are written. */
function readJsonc(text: string): Record<string, unknown> | null {
  const stripped = text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, close: string | undefined) => close ?? m);
  try {
    const parsed: unknown = JSON.parse(stripped);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
