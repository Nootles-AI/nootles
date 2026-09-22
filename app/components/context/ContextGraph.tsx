"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog } from "../Dialog";
import { useOpenPage } from "../OpenPageContext";
import { Search, X } from "../Icons";
import { GraphCanvas } from "./graph/GraphCanvas";
import { InfoPanel } from "./graph/InfoPanel";
import { buildGraph, PROJECT, type ViewNode } from "./graph/model";
import "./graph/graph.css";

/**
 * The project's context, as a map: every page and folder, the lines between
 * them, and — floating on the right — everything known about whatever is
 * selected. Opened from the sidebar's Context row; the project is selected
 * first, and its panel is where Description and Context are written.
 */
export function ContextGraph({
  projectId,
  onClose,
}: {
  projectId: Id<"projects">;
  onClose: () => void;
}) {
  const data = useQuery(api.context.read.graph, { projectId });
  const { open } = useOpenPage();
  const graph = useMemo(() => (data ? buildGraph(data) : null), [data]);
  const [chosen, setChosen] = useState(PROJECT);
  const [query, setQuery] = useState("");
  const [centreOn, setCentreOn] = useState<{ id: string; nonce: number } | null>(null);
  const panel = useRef<HTMLElement>(null);

  // A selection whose node has gone — a page trashed in another tab — falls
  // back to the project rather than to a panel about nothing.
  const byId = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n])), [graph]);
  const selected = byId.has(chosen) ? chosen : PROJECT;
  const node = byId.get(selected);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !graph) return null;
    return new Set(graph.nodes.filter((n) => searchable(n).includes(q)).map((n) => n.id));
  }, [graph, query]);

  const select = (id: string, centre = false) => {
    setChosen(id);
    if (centre) setCentreOn((c) => ({ id, nonce: (c?.nonce ?? 0) + 1 }));
  };

  return (
    <Dialog label="Project context" className="nt-graph" onClose={onClose}>
      {(close) => {
        const openPage = (pageId: string) => {
          open(pageId as Id<"pages">);
          close();
        };
        return (
          <>
            {graph && data && node ? (
              <GraphCanvas
                nodes={graph.nodes}
                edges={graph.edges}
                selected={selected}
                matches={matches}
                centreOn={centreOn}
                reserve={() => {
                  const el = panel.current;
                  if (!el) return { right: 0, bottom: 0 };
                  // Beside the canvas on a wide screen, under it on a narrow one.
                  const docked = el.offsetTop > 40;
                  return docked
                    ? { right: 0, bottom: el.offsetHeight + 12 }
                    : { right: el.offsetWidth + 24, bottom: 0 };
                }}
                onSelect={(id) => select(id)}
                onOpen={openPage}
              />
            ) : (
              <div className="nt-graph-stage" aria-busy="true" />
            )}

            <div className="nt-graph-bar">
              <label className="nt-graph-search">
                <Search width={14} height={14} aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query) {
                      e.stopPropagation();
                      setQuery("");
                    }
                    if (e.key === "Enter" && matches?.size) {
                      const first = graph?.nodes.find((n) => matches.has(n.id));
                      if (first) select(first.id, true);
                    }
                  }}
                  placeholder="Find a page"
                  aria-label="Find a page in the graph"
                  spellCheck={false}
                />
              </label>
              {matches !== null && (
                <span className="nt-graph-found" aria-live="polite">
                  {matches.size === 0
                    ? "Nothing matches"
                    : matches.size === 1
                      ? "One match"
                      : `${matches.size} matches`}
                </span>
              )}
            </div>

            <aside ref={panel} className="nt-ginfo" aria-label="Selected in the graph">
              <div className="nt-ginfo-top">
                <span className="nt-ginfo-kind">{node ? KIND[node.kind] : "Context"}</span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close context"
                  title="Close"
                  className="nt-icon-btn"
                >
                  <X />
                </button>
              </div>
              {data && node && graph ? (
                <InfoPanel
                  key={node.id}
                  projectId={projectId}
                  data={data}
                  node={node}
                  edges={graph.edges}
                  onSelect={(id) => select(id, true)}
                  onOpen={openPage}
                />
              ) : (
                <div className="nt-ginfo-body" />
              )}
            </aside>
          </>
        );
      }}
    </Dialog>
  );
}

const KIND = {
  project: "Project",
  folder: "Folder",
  page: "Page",
  repo: "Repository",
  area: "Area of the code",
  concern: "Concern",
  document: "Document",
} as const;

function searchable(node: ViewNode): string {
  switch (node.kind) {
    case "project":
      return node.title.toLowerCase();
    case "folder":
      return node.folder.title.toLowerCase();
    case "page":
      return `${node.page.title}\n${node.page.brief}`.toLowerCase();
    case "repo":
      return `${node.repo.fullName}\n${node.repo.description}`.toLowerCase();
    case "area":
      return `${node.area.title}\n${node.area.brief}`.toLowerCase();
    case "concern":
      return `${node.concern.title}\n${node.concern.brief}`.toLowerCase();
    case "document":
      return `${node.doc.title}\n${node.doc.brief}`.toLowerCase();
  }
}
