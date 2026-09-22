import { SCRIPT_LANGUAGES, STYLE_LANGUAGES, type ParsedFile } from "./parse";
import type { Reference } from "./resolve";
import { isTest } from "./select";

/**
 * Stage 1: a repo's files grouped into areas, and areas into concerns.
 *
 * Louvain twice, per the spike — once over the whole graph for areas, then
 * inside each area at a finer resolution for concerns — because no single
 * resolution recovers both a feature's front and back end and the small
 * concerns beside it. In-house and randomness-free: nodes are visited in path
 * order, so the same repo clusters the same way every time.
 *
 * Styling is the exception to structure. A design system is imported by
 * everything, so the graph smears it across every feature that uses it; but it
 * is exactly what a person drawing a mockup needs in one place, so it is
 * pulled out before clustering and kept as one concern of its own.
 */

export type Concern = { id: string; name: string; files: string[]; styling?: true };
export type Area = { id: string; name: string; concerns: Concern[] };
export type Clustering = {
  areas: Area[];
  rollups: { from: string; to: string; weight: number }[];
};

const AREA_RESOLUTION = 1;
const CONCERN_RESOLUTION = 3;
const MAX_CONCERN = 60;
const TINY = 2;
const COCHANGE_CAP = 3;
const MAX_COMPONENTS = 60;

const STYLING_AREA = { id: "area:styling", name: "Styling" };
const STYLING_CONCERN = { id: "concern:styling-and-components", name: "Styling and components" };

export function cluster(input: {
  files: ParsedFile[];
  references: Reference[];
  cochange: { a: string; b: string; weight: number }[];
}): Clustering {
  const paths = [...new Set(input.files.map((f) => f.path))].sort(compare);
  const graph = combinedGraph(paths, input.references, input.cochange);
  const styling = hasGui(input.files) ? stylingFiles(input.files, input.references) : null;

  const rest = paths.map((_, i) => i).filter((i) => !styling?.has(paths[i]));
  const groups = partition(graph, rest, paths);
  const areas = label(groups, graph, paths);
  if (styling) {
    areas.push({
      ...STYLING_AREA,
      concerns: [{ ...STYLING_CONCERN, files: [...styling].sort(compare), styling: true }],
    });
  }
  areas.sort((a, b) => compare(a.name, b.name));
  return { areas, rollups: rollups(graph, paths, areas) };
}

// ---------------------------------------------------------------- the graph

type Graph = { n: number; adj: Map<number, number>[]; loops: number[] };

function emptyGraph(n: number): Graph {
  return { n, adj: Array.from({ length: n }, () => new Map()), loops: new Array(n).fill(0) };
}

function link(g: Graph, i: number, j: number, w: number) {
  if (i === j || !(w > 0)) return;
  g.adj[i].set(j, (g.adj[i].get(j) ?? 0) + w);
  g.adj[j].set(i, (g.adj[j].get(i) ?? 0) + w);
}

/**
 * References and co-change on one scale. A reference to a file everything
 * imports says little about either end, so it is damped by the target's
 * in-degree; co-change is divided by its mean and capped, so one noisy pair
 * cannot outweigh a dozen imports.
 */
function combinedGraph(
  paths: string[],
  references: Reference[],
  cochange: { a: string; b: string; weight: number }[],
): Graph {
  const index = new Map(paths.map((p, i) => [p, i]));
  const g = emptyGraph(paths.length);

  const importers = new Map<string, Set<string>>();
  for (const r of references) {
    if (!index.has(r.from) || !index.has(r.to)) continue;
    const set = importers.get(r.to) ?? new Set();
    set.add(r.from);
    importers.set(r.to, set);
  }
  for (const r of references) {
    const from = index.get(r.from);
    const to = index.get(r.to);
    if (from === undefined || to === undefined) continue;
    link(g, from, to, 1 / Math.log2(2 + (importers.get(r.to)?.size ?? 0)));
  }

  const known = cochange.filter((c) => index.has(c.a) && index.has(c.b));
  const mean = known.reduce((sum, c) => sum + c.weight, 0) / (known.length || 1);
  for (const c of known) {
    link(g, index.get(c.a)!, index.get(c.b)!, Math.min(COCHANGE_CAP, c.weight / mean));
  }
  return g;
}

function induced(g: Graph, nodes: number[]): Graph {
  const local = new Map(nodes.map((node, i) => [node, i]));
  const sub = emptyGraph(nodes.length);
  nodes.forEach((node, i) => {
    for (const [other, w] of g.adj[node]) {
      const j = local.get(other);
      if (j !== undefined && j > i) link(sub, i, j, w);
    }
  });
  return sub;
}

// ---------------------------------------------------------------- louvain

/** Community per node, numbered by first appearance in node order. */
function louvain(g: Graph, resolution: number): number[] {
  let graph = g;
  let membership = graph.adj.map((_, i) => i);
  for (let level = 0; level < 32; level++) {
    const community = localMoving(graph, resolution);
    if (!community) break;
    const { labels, count } = relabel(community);
    membership = membership.map((node) => labels[node]);
    graph = aggregate(graph, labels, count);
  }
  return relabel(membership).labels;
}

/**
 * Moves each node to the neighbouring community with the largest modularity
 * gain until none moves; null when nothing moved at all.
 */
function localMoving(g: Graph, resolution: number): number[] | null {
  const neighbours = g.adj.map((m) => [...m].sort((a, b) => a[0] - b[0]));
  const degree = neighbours.map((list, i) => list.reduce((s, [, w]) => s + w, 0) + 2 * g.loops[i]);
  const total = degree.reduce((s, d) => s + d, 0);
  if (total === 0) return null;

  const community = degree.map((_, i) => i);
  const tot = degree.slice();
  let moved = false;
  for (let pass = 0; pass < 64; pass++) {
    let improved = false;
    for (let i = 0; i < g.n; i++) {
      const own = community[i];
      const links = new Map<number, number>();
      for (const [j, w] of neighbours[i]) {
        links.set(community[j], (links.get(community[j]) ?? 0) + w);
      }
      tot[own] -= degree[i];
      const gain = (c: number) =>
        (links.get(c) ?? 0) - (resolution * tot[c] * degree[i]) / total;
      let best = own;
      let bestGain = gain(own);
      for (const c of links.keys()) {
        const g2 = gain(c);
        // The margin keeps float noise from trading nodes back and forth.
        if (c !== own && g2 > bestGain + 1e-12) {
          best = c;
          bestGain = g2;
        }
      }
      tot[best] += degree[i];
      if (best !== own) {
        community[i] = best;
        improved = true;
        moved = true;
      }
    }
    if (!improved) break;
  }
  return moved ? community : null;
}

function relabel(community: number[]): { labels: number[]; count: number } {
  const map = new Map<number, number>();
  const labels = community.map((c) => {
    if (!map.has(c)) map.set(c, map.size);
    return map.get(c)!;
  });
  return { labels, count: map.size };
}

function aggregate(g: Graph, labels: number[], count: number): Graph {
  const next = emptyGraph(count);
  for (let i = 0; i < g.n; i++) {
    next.loops[labels[i]] += g.loops[i];
    for (const [j, w] of g.adj[i]) {
      if (j < i) continue;
      if (labels[i] === labels[j]) next.loops[labels[i]] += w;
      else link(next, labels[i], labels[j], w);
    }
  }
  return next;
}

// ---------------------------------------------------------------- partition

type Group = { concerns: number[][] };

function partition(g: Graph, nodes: number[], paths: string[]): Group[] {
  const sub = induced(g, nodes);
  const connected = nodes.filter((_, i) => sub.adj[i].size > 0);
  const pool = nodes.filter((_, i) => sub.adj[i].size === 0);
  const groups: Group[] = [];

  const areaSub = induced(g, connected);
  for (const members of groupsOf(louvain(areaSub, AREA_RESOLUTION), connected)) {
    // An area of one or two files is a pair nothing else touches: grouping
    // it by where it lives says more than keeping it apart.
    if (members.length <= TINY) {
      pool.push(...members);
      continue;
    }
    const inner = groupsOf(louvain(induced(g, members), CONCERN_RESOLUTION), members);
    groups.push({ concerns: settle(inner.flatMap((c) => split(c, paths)), g, paths) });
  }

  const byTop = new Map<string, number[]>();
  for (const node of pool.sort((a, b) => a - b)) {
    const key = dirs(paths[node]).slice(0, 1).join("/");
    byTop.set(key, [...(byTop.get(key) ?? []), node]);
  }
  for (const members of byTop.values()) {
    const byDir = new Map<string, number[]>();
    for (const node of members) {
      const key = dirs(paths[node]).slice(0, 2).join("/");
      byDir.set(key, [...(byDir.get(key) ?? []), node]);
    }
    const concerns = [...byDir.values()].flatMap((c) => split(c, paths));
    groups.push({ concerns: settle(concerns, g, paths) });
  }
  return groups;
}

function groupsOf(labels: number[], nodes: number[]): number[][] {
  const groups: number[][] = [];
  labels.forEach((label, i) => (groups[label] ??= []).push(nodes[i]));
  return groups;
}

/**
 * An oversized concern splits where its files' directories first part ways;
 * a single flat directory is cut into runs of adjacent paths.
 */
function split(nodes: number[], paths: string[]): number[][] {
  if (nodes.length <= MAX_CONCERN) return [nodes];
  const shared = commonDirs(nodes.map((n) => paths[n])).length;
  const byNext = new Map<string, number[]>();
  for (const node of [...nodes].sort((a, b) => a - b)) {
    const key = dirs(paths[node])[shared] ?? "";
    byNext.set(key, [...(byNext.get(key) ?? []), node]);
  }
  if (byNext.size > 1) return [...byNext.values()].flatMap((part) => split(part, paths));
  const sorted = [...nodes].sort((a, b) => a - b);
  const runs = Math.ceil(sorted.length / MAX_CONCERN);
  const size = Math.ceil(sorted.length / runs);
  return Array.from({ length: runs }, (_, r) => sorted.slice(r * size, (r + 1) * size));
}

/**
 * Folds concerns of one or two files into the neighbour they are most tied
 * to, or failing any tie, the one living nearest in the tree — never past the
 * size a concern is allowed.
 */
function settle(concerns: number[][], g: Graph, paths: string[]): number[][] {
  let list = concerns.map((c) => [...c].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  for (let merged = true; merged && list.length > 1; ) {
    merged = false;
    for (let t = 0; t < list.length && list.length > 1; t++) {
      const tiny = list[t];
      if (tiny.length === 0 || tiny.length > TINY) continue;
      const target = mergeTarget(tiny, list, t, g, paths);
      if (target < 0) continue;
      list[target] = [...list[target], ...tiny].sort((a, b) => a - b);
      list[t] = [];
      merged = true;
    }
    list = list.filter((c) => c.length > 0).sort((a, b) => a[0] - b[0]);
  }
  return list;
}

function mergeTarget(
  tiny: number[],
  list: number[][],
  self: number,
  g: Graph,
  paths: string[],
): number {
  const owner = new Map<number, number>();
  list.forEach((c, i) => c.forEach((node) => owner.set(node, i)));
  const ties = new Map<number, number>();
  for (const node of tiny) {
    for (const [other, w] of g.adj[node]) {
      const c = owner.get(other);
      if (c !== undefined && c !== self) ties.set(c, (ties.get(c) ?? 0) + w);
    }
  }
  const room = (i: number) =>
    i !== self && list[i].length > 0 && list[i].length + tiny.length <= MAX_CONCERN;
  let best = -1;
  let bestScore = 0;
  for (const [c, w] of [...ties].sort((a, b) => a[0] - b[0])) {
    if (room(c) && w > bestScore) {
      best = c;
      bestScore = w;
    }
  }
  if (best >= 0) return best;

  const home = dirs(paths[tiny[0]]);
  let nearest = -1;
  bestScore = -1;
  list.forEach((c, i) => {
    if (!room(i)) return;
    const score = Math.max(...c.map((node) => sharedLength(home, dirs(paths[node]))));
    if (score > bestScore) {
      nearest = i;
      bestScore = score;
    }
  });
  return nearest;
}

// ---------------------------------------------------------------- styling

const GUI_LANGUAGES = new Set(["tsx", "jsx", "vue", "svelte", "html"]);
const THEME = /(^|\/)(theme|tokens?|design[-_]?system|styles?)(\/|\.|$)/i;
/**
 * Where a "tokens" or "theme" file is about something else — auth tokens,
 * a server's theme setting. The name alone would sweep them into Styling.
 */
const SERVER_DIRS = new Set([
  "convex", "server", "servers", "api", "backend", "functions", "lambda", "db",
  "database", "migrations", "prisma", "auth", "cmd", "internal",
]);
const BUILD_CONFIG = /(^|\/)(tailwind|postcss)\.config\.[^/]+$/;
const LIBRARY_DIRS = new Set(["ui", "design-system", "design_system", "designsystem", "primitives"]);

function hasGui(files: ParsedFile[]): boolean {
  return files.some((f) => GUI_LANGUAGES.has(f.language) || STYLE_LANGUAGES.has(f.language));
}

/**
 * Every style sheet, the theme and token files, and the shared component
 * library — the files imported by at least three others in a place a UI kit
 * lives, most-imported first.
 */
function stylingFiles(files: ParsedFile[], references: Reference[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (isTest(f.path)) continue;
    const theme = THEME.test(f.path) && !dirs(f.path).some((d) => SERVER_DIRS.has(d.toLowerCase()));
    if (STYLE_LANGUAGES.has(f.language) || theme || BUILD_CONFIG.test(f.path)) {
      out.add(f.path);
    }
  }

  const importers = new Map<string, Set<string>>();
  for (const r of references) {
    if (r.type !== "imports") continue;
    importers.set(r.to, (importers.get(r.to) ?? new Set()).add(r.from));
  }
  const reach = (path: string) => importers.get(path)?.size ?? 0;
  const pick = (fits: (f: ParsedFile) => boolean) =>
    files
      .filter((f) => !out.has(f.path) && SCRIPT_LANGUAGES.has(f.language) && !isTest(f.path) && fits(f))
      .sort((a, b) => reach(b.path) - reach(a.path) || compare(a.path, b.path))
      .slice(0, MAX_COMPONENTS);

  const library = pick((f) => inLibrary(f.path) && reach(f.path) >= 3);
  // A GUI with no sheets and no kit still has a most-shared component or two.
  const components = out.size || library.length
    ? library
    : pick((f) => GUI_LANGUAGES.has(f.language) && reach(f.path) >= 2);
  for (const f of components) out.add(f.path);
  return out;
}

/**
 * A kit's folder anywhere, or a `components/` folder near the root holding
 * files directly — its subfolders are usually features, not the kit.
 */
function inLibrary(path: string): boolean {
  const segments = dirs(path);
  const last = segments.length - 1;
  return (
    segments.some((segment) => LIBRARY_DIRS.has(segment.toLowerCase())) ||
    (segments[last] === "components" && last <= 1)
  );
}

// ---------------------------------------------------------------- names

const GENERIC = new Set(["src", "lib", "libs", "app", "apps", "components", "packages", "internal", "pkg", "source"]);

type Named = { segments: string[]; nodes: number[] };

/** Groups become areas and concerns with readable, repo-unique names and ids. */
function label(groups: Group[], g: Graph, paths: string[]): Area[] {
  const areaNames = unique(
    groups.map((group) => ({ segments: basis(group.concerns.flat(), paths), nodes: group.concerns.flat() })),
    [STYLING_AREA.name],
    g,
    paths,
  );
  const flat = groups.flatMap((group, a) => group.concerns.map((nodes) => ({ a, nodes })));
  const concernNames = unique(
    flat.map(({ nodes }) => ({ segments: basis(nodes, paths), nodes })),
    [STYLING_CONCERN.name],
    g,
    paths,
  );

  const ids = new Set<string>([STYLING_AREA.id, STYLING_CONCERN.id]);
  const claim = (id: string) => {
    let candidate = id;
    for (let k = 2; ids.has(candidate); k++) candidate = `${id}-${k}`;
    ids.add(candidate);
    return candidate;
  };
  const areas: Area[] = groups.map((_, a) => ({
    id: claim(`area:${slug(areaNames[a])}`),
    name: areaNames[a],
    concerns: [],
  }));
  flat.forEach(({ a, nodes }, c) => {
    const area = areas[a];
    area.concerns.push({
      id: claim(`concern:${area.id.slice("area:".length)}/${slug(concernNames[c])}`),
      name: concernNames[c],
      files: nodes.map((n) => paths[n]).sort(compare),
    });
  });
  for (const area of areas) area.concerns.sort((x, y) => compare(x.name, y.name));
  return areas;
}

/**
 * The directory a group lives in: the deepest one holding most of its files —
 * the common prefix when they all share one, but not dragged up to the root by
 * one stray file — else the directory holding the most of them.
 */
function basis(nodes: number[], paths: string[]): string[] {
  const files = nodes.map((n) => paths[n]);
  const prefixes = new Map<string, number>();
  const parents = new Map<string, number>();
  for (const f of files) {
    const d = dirs(f);
    for (let k = 1; k <= d.length; k++) {
      const key = d.slice(0, k).join("/");
      prefixes.set(key, (prefixes.get(key) ?? 0) + 1);
    }
    parents.set(d.join("/"), (parents.get(d.join("/")) ?? 0) + 1);
  }
  const depthOf = (key: string) => (key ? key.split("/").length : 0);
  const [majority] = [...prefixes]
    .filter(([, count]) => count * 2 > files.length)
    .sort((a, b) => depthOf(b[0]) - depthOf(a[0]) || b[1] - a[1] || compare(a[0], b[0]));
  const [parent] = [...parents].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]));
  const split = (key: string | undefined) => (key ? key.split("/") : []);
  if (majority && meaningful(split(majority[0])).length) return split(majority[0]);
  if (parent && meaningful(split(parent[0])).length) return split(parent[0]);
  return split(majority?.[0] ?? parent?.[0]);
}

/**
 * Names from the last two meaningful directory segments. A duplicate reaches
 * further up its tree — past the generic segments too, since `lib/notion` and
 * `components/notion` differ only there — then takes its best-connected
 * file's name, and only then a number.
 */
function unique(items: Named[], reserved: string[], g: Graph, paths: string[]): string[] {
  const trails = items.map((item) => {
    const cleaned = item.segments.map(clean).filter(Boolean);
    const first = cleaned.findIndex((s) => !GENERIC.has(s.toLowerCase()));
    return {
      words: meaningful(item.segments),
      before: first < 0 ? cleaned : cleaned.slice(0, first),
    };
  });
  const initial = trails.map((t) =>
    t.words.length ? Math.min(2, t.words.length) : Math.min(1, t.before.length),
  );
  const depth = initial.slice();
  const nameAt = (i: number) => {
    const { words, before } = trails[i];
    const d = depth[i];
    if (d <= words.length) return readable(words.slice(words.length - d));
    return readable([...before.slice(before.length - (d - words.length)), ...words]);
  };
  let names = items.map((_, i) => nameAt(i));

  for (;;) {
    let grew = false;
    for (const i of clashes(names, reserved)) {
      if (depth[i] < trails[i].words.length + trails[i].before.length) {
        depth[i]++;
        grew = true;
      }
    }
    if (!grew) break;
    names = items.map((_, i) => nameAt(i));
  }

  // Reaching up did not separate these (they live in the same place), so
  // they go back to the short name and are told apart by their files.
  const stuck = clashes(names, reserved);
  for (const i of stuck) depth[i] = initial[i];
  for (const i of stuck) {
    const hub = hubFile(items[i].nodes, g, paths);
    names[i] = hub ? `${nameAt(i)} (${hub})` : nameAt(i);
  }
  const seen = new Map<string, number>(reserved.map((r) => [r, 1]));
  const order = items
    .map((item, i) => ({ i, first: Math.min(...item.nodes) }))
    .sort((a, b) => a.first - b.first);
  for (const { i } of order) {
    const count = (seen.get(names[i]) ?? 0) + 1;
    seen.set(names[i], count);
    if (count > 1) names[i] = `${names[i]} ${count}`;
  }
  return names;
}

function clashes(names: string[], reserved: string[]): number[] {
  const counts = new Map<string, number>(reserved.map((r) => [r, 1]));
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return names.flatMap((name, i) => ((counts.get(name) ?? 0) > 1 ? [i] : []));
}

function hubFile(nodes: number[], g: Graph, paths: string[]): string {
  const weight = (n: number) => [...g.adj[n].values()].reduce((s, w) => s + w, 0);
  const [hub] = [...nodes].sort((a, b) => weight(b) - weight(a) || a - b);
  if (hub === undefined) return "";
  const name = paths[hub].slice(paths[hub].lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return splitWords(name).join(" ");
}

function meaningful(segments: string[]): string[] {
  return segments.map(clean).filter((s) => s && !GENERIC.has(s.toLowerCase()));
}

const ACRONYMS = new Set(["ai", "api", "ci", "cli", "css", "db", "html", "io", "mcp", "sdk", "sql", "ui", "url", "ux"]);

function readable(segments: string[]): string {
  const parts = segments.flatMap(splitWords);
  const deduped = parts.filter((w, i) => w !== parts[i - 1]);
  if (!deduped.length) return "Root";
  const text = deduped.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
  return text[0].toUpperCase() + text.slice(1);
}

function clean(segment: string): string {
  return segment.replace(/[()[\]{}@]/g, "").replace(/^[._]+/, "");
}

function splitWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

// ---------------------------------------------------------------- rollups

function rollups(g: Graph, paths: string[], areas: Area[]): Clustering["rollups"] {
  const concernOf = new Map<string, string>();
  for (const area of areas) for (const c of area.concerns) for (const f of c.files) concernOf.set(f, c.id);
  const sums = new Map<string, number>();
  for (let i = 0; i < g.n; i++) {
    for (const [j, w] of [...g.adj[i]].sort((a, b) => a[0] - b[0])) {
      if (j < i) continue;
      const a = concernOf.get(paths[i]);
      const b = concernOf.get(paths[j]);
      if (!a || !b || a === b) continue;
      const key = a < b ? `${a}\n${b}` : `${b}\n${a}`;
      sums.set(key, (sums.get(key) ?? 0) + w);
    }
  }
  return [...sums]
    .filter(([, weight]) => weight > 0)
    .map(([key, weight]) => {
      const [from, to] = key.split("\n");
      return { from, to, weight };
    })
    .sort((x, y) => y.weight - x.weight || compare(x.from, y.from) || compare(x.to, y.to));
}

// ---------------------------------------------------------------- paths

function dirs(path: string): string[] {
  return path.split("/").slice(0, -1);
}

function commonDirs(files: string[]): string[] {
  if (!files.length) return [];
  let common = dirs(files[0]);
  for (const f of files.slice(1)) common = common.slice(0, sharedLength(common, dirs(f)));
  return common;
}

function sharedLength(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
