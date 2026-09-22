import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

/**
 * The context view's picture of a project: one hub for the project itself,
 * its folders, its pages, and two kinds of line between them. `contains` is
 * the sidebar's own structure, drawn quietly so a project with no mentions
 * still has a shape; `mentions` is what the pages say about each other, drawn
 * as the thing worth looking at.
 */
export type GraphData = NonNullable<FunctionReturnType<typeof api.context.read.graph>>;
export type GraphPage = GraphData["pages"][number];
export type GraphFolder = GraphData["folders"][number];
export type GraphRepo = GraphData["code"]["repos"][number];
export type GraphArea = GraphData["code"]["areas"][number];
export type GraphConcern = GraphData["code"]["concerns"][number];
export type GraphDocument = GraphData["documents"][number];

export type ViewNode =
  | { id: "project"; kind: "project"; title: string }
  | { id: string; kind: "folder"; folder: GraphFolder }
  | { id: string; kind: "page"; page: GraphPage }
  | { id: string; kind: "repo"; repo: GraphRepo }
  | { id: string; kind: "area"; area: GraphArea }
  | { id: string; kind: "concern"; concern: GraphConcern }
  | { id: string; kind: "document"; doc: GraphDocument };

export type ViewEdge = {
  id: string;
  source: string;
  target: string;
  /** `works` is the summed pull between two concerns — code that moves together. */
  kind: "contains" | "mentions" | "works";
  weight?: number;
};

/** Past this many, a concern's weakest ties are left off the map: they are noise. */
const WORKS_PER_CONCERN = 3;

export const PROJECT = "project";
export const folderKey = (folderId: string) => `f:${folderId}`;
export const pageKey = (pageId: string) => `p:${pageId}`;
export const repoKey = (repoId: string) => `r:${repoId}`;
export const codeKey = (nodeId: string) => `n:${nodeId}`;
export const docKey = (nodeId: string) => `d:${nodeId}`;

export function buildGraph(data: GraphData): { nodes: ViewNode[]; edges: ViewEdge[] } {
  const nodes: ViewNode[] = [{ id: PROJECT, kind: "project", title: data.title }];
  const edges: ViewEdge[] = [];
  const folders = new Set(data.folders.map((f) => f.folderId));
  // A row whose parent is gone hangs off the project, as the sidebar shows it.
  const parent = (id: string | null) => (id && folders.has(id) ? folderKey(id) : PROJECT);
  const contains = (from: string, to: string) =>
    edges.push({ id: `${from}>${to}`, source: from, target: to, kind: "contains" });

  for (const folder of data.folders) {
    const id = folderKey(folder.folderId);
    nodes.push({ id, kind: "folder", folder });
    contains(parent(folder.parentId), id);
  }
  for (const page of data.pages) {
    const id = pageKey(page.pageId);
    nodes.push({ id, kind: "page", page });
    contains(parent(page.folderId), id);
  }
  for (const doc of data.documents) {
    nodes.push({ id: docKey(doc.nodeId), kind: "document", doc });
    contains(PROJECT, docKey(doc.nodeId));
  }

  const repoOfNode = new Map<string, string>();
  for (const repo of data.code.repos) {
    const id = repoKey(repo.repoId);
    nodes.push({ id, kind: "repo", repo });
    contains(PROJECT, id);
    if (repo.nodeId) repoOfNode.set(repo.nodeId, id);
  }
  const areaIds = new Set(data.code.areas.map((a) => a.nodeId));
  for (const area of data.code.areas) {
    const up = area.parentId ? repoOfNode.get(area.parentId) : undefined;
    if (!up) continue;
    nodes.push({ id: codeKey(area.nodeId), kind: "area", area });
    contains(up, codeKey(area.nodeId));
  }
  const placed = new Set<string>();
  for (const concern of data.code.concerns) {
    if (!concern.parentId || !areaIds.has(concern.parentId)) continue;
    nodes.push({ id: codeKey(concern.nodeId), kind: "concern", concern });
    contains(codeKey(concern.parentId), codeKey(concern.nodeId));
    placed.add(concern.nodeId);
  }
  // Each concern keeps its strongest ties only, so the map shows structure
  // rather than every import anyone ever wrote.
  const strongest = new Map<string, { from: string; to: string; weight: number }[]>();
  for (const r of [...data.code.rollups].sort((a, b) => b.weight - a.weight)) {
    if (!placed.has(r.from) || !placed.has(r.to)) continue;
    const a = strongest.get(r.from) ?? [];
    const b = strongest.get(r.to) ?? [];
    if (a.length >= WORKS_PER_CONCERN && b.length >= WORKS_PER_CONCERN) continue;
    a.push(r);
    b.push(r);
    strongest.set(r.from, a);
    strongest.set(r.to, b);
  }
  const works = new Set([...strongest.values()].flat());
  for (const r of works) {
    edges.push({
      id: `${codeKey(r.from)}=${codeKey(r.to)}`,
      source: codeKey(r.from),
      target: codeKey(r.to),
      kind: "works",
      weight: r.weight,
    });
  }

  const seen = new Set<string>();
  for (const { from, to } of data.mentions) {
    const id = `${pageKey(from)}~${pageKey(to)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, source: pageKey(from), target: pageKey(to), kind: "mentions" });
  }
  return { nodes, edges };
}

/** Every node one line away, either direction, keyed by node. */
export function neighbours(edges: readonly ViewEdge[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!out.has(a)) out.set(a, new Set());
    out.get(a)!.add(b);
  };
  for (const e of edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  return out;
}

/** How a page opens, off the templated summary — everything after its outline. */
export function openingOf(summary: string): string {
  if (!summary.startsWith("Sections: ")) return summary;
  const cut = summary.indexOf("\n");
  return cut === -1 ? "" : summary.slice(cut + 1);
}

/** A page's sections, off the templated summary's first line. */
export function sectionsOf(summary: string): string[] {
  const first = summary.split("\n", 1)[0] ?? "";
  if (!first.startsWith("Sections: ")) return [];
  return first
    .slice("Sections: ".length)
    .split(" · ")
    .map((s) => s.trim())
    .filter(Boolean);
}
