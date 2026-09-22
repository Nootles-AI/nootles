/**
 * Which files of a repository are worth a node in the context graph.
 *
 * An allow-list of extensions rather than a deny-list of binaries: a format we
 * have never heard of is far more likely to be data than source, and indexing
 * it costs every later stage.
 */

export const MAX_FILES = 4000;
const MAX_BYTES = 300_000;

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "swift",
  "rb", "php", "cs", "c", "h", "cpp", "hpp", "scala", "vue", "svelte",
]);
const STYLE = new Set(["css", "scss", "sass", "less", "styl"]);
const CONFIG = new Set(["html", "json", "yaml", "yml", "toml", "sql", "graphql", "prisma", "sh"]);
const DOCS = new Set(["md", "mdx"]);

const SKIPPED_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", "out", ".next", "coverage", "target",
  ".git", "__pycache__", "venv", ".venv", "third_party", "_generated", "__generated__",
  "generated",
]);

const LOCK_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
  "Gemfile.lock", "go.sum", "bun.lockb", "composer.lock",
]);

export function keep(path: string, size: number): boolean {
  if (size > MAX_BYTES) return false;
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (segments.slice(0, -1).some((dir) => SKIPPED_DIRS.has(dir))) return false;
  if (LOCK_FILES.has(name)) return false;
  if (/\.min\.(js|css)$/.test(name) || name.endsWith(".map")) return false;
  const ext = extension(name);
  return CODE.has(ext) || STYLE.has(ext) || CONFIG.has(ext) || DOCS.has(ext);
}

/**
 * The files a repo too large to index whole is represented by: its source
 * before its tests and docs, and the top of the tree before its depths, where
 * a reader starts too. Returned in path order.
 */
export function prioritise(paths: string[]): string[] {
  const sorted = [...paths].sort(byPath);
  if (sorted.length <= MAX_FILES) return sorted;
  return sorted
    .map((path) => ({ path, tier: tier(path), depth: path.split("/").length }))
    .sort((a, b) => a.tier - b.tier || a.depth - b.depth || byPath(a.path, b.path))
    .slice(0, MAX_FILES)
    .map((entry) => entry.path)
    .sort(byPath);
}

function tier(path: string): number {
  if (isTest(path)) return 3;
  const ext = extension(path);
  if (CODE.has(ext) || STYLE.has(ext)) return 0;
  if (DOCS.has(ext)) return 2;
  return 1;
}

export function isTest(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|fixtures?)\//.test(path) ||
    /\.(test|spec)\.[^.]+$/.test(name) ||
    /_test\.go$/.test(name) ||
    /^test_.*\.py$|_test\.py$/.test(name)
  );
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  const slash = name.lastIndexOf("/");
  return dot > slash + 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
