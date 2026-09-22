"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { when } from "@/app/lib/projectMeta";
import { PagePreview } from "../../PagePreview";
import { RowIcon } from "../../rowIcon";
import { ContextFields } from "../ContextFields";
import {
  folderKey,
  openingOf,
  pageKey,
  sectionsOf,
  type GraphData,
  type GraphPage,
  type ViewEdge,
  type ViewNode,
} from "./model";

/**
 * Everything the graph knows about the selected node, floating over the right
 * of the canvas. The project is the default selection, and its panel is where
 * the project's own words are written — so the view that shows what the
 * assistant reads is also where that reading starts.
 */
export function InfoPanel({
  projectId,
  data,
  node,
  edges,
  onSelect,
  onOpen,
}: {
  projectId: Id<"projects">;
  data: GraphData;
  node: ViewNode;
  edges: readonly ViewEdge[];
  onSelect: (id: string) => void;
  onOpen: (pageId: string) => void;
}) {
  if (node.kind === "project") return <ProjectInfo projectId={projectId} data={data} edges={edges} />;
  if (node.kind === "folder") {
    const inside = edges.filter((e) => e.kind === "contains" && e.source === node.id);
    return (
      <div className="nt-ginfo-body">
        <header className="nt-ginfo-head">
          <RowIcon icon={node.folder.icon} kind="folder" size={16} className="nt-ginfo-glyph" />
          <h2 className="nt-ginfo-title">{node.folder.title.trim() || "Untitled folder"}</h2>
        </header>
        <p className="nt-ginfo-meta">
          {inside.length === 1 ? "Holds one item" : `Holds ${inside.length} items`}
        </p>
        <Links
          title="Inside"
          ids={inside.map((e) => e.target)}
          data={data}
          onSelect={onSelect}
        />
      </div>
    );
  }
  return (
    <PageInfo
      projectId={projectId}
      page={node.page}
      data={data}
      edges={edges}
      onSelect={onSelect}
      onOpen={onOpen}
    />
  );
}

function ProjectInfo({
  projectId,
  data,
  edges,
}: {
  projectId: Id<"projects">;
  data: GraphData;
  edges: readonly ViewEdge[];
}) {
  const links = edges.filter((e) => e.kind === "mentions").length;
  const unread = data.pages.filter((p) => !p.digested).length;
  return (
    <div className="nt-ginfo-body">
      <header>
        <h2 className="nt-ginfo-title is-project">{data.title.trim() || "Untitled project"}</h2>
        <p className="nt-ginfo-lede">
          What the assistant reads before it answers: what you say about the
          project here, then what its pages say.
        </p>
      </header>

      <dl className="nt-ginfo-stats">
        <div>
          <dt>Pages</dt>
          <dd>{data.pages.length}</dd>
        </div>
        <div>
          <dt>Links</dt>
          <dd>{links}</dd>
        </div>
        <div>
          <dt>Folders</dt>
          <dd>{data.folders.length}</dd>
        </div>
      </dl>

      <ContextFields projectId={projectId} />

      {unread > 0 && (
        <p className="nt-ginfo-note">
          {unread === 1 ? "One page has" : `${unread} pages have`} no words in context
          yet. A page joins the next time it is opened or edited.
        </p>
      )}
    </div>
  );
}

function PageInfo({
  projectId,
  page,
  data,
  edges,
  onSelect,
  onOpen,
}: {
  projectId: Id<"projects">;
  page: GraphPage;
  data: GraphData;
  edges: readonly ViewEdge[];
  onSelect: (id: string) => void;
  onOpen: (pageId: string) => void;
}) {
  const read = useQuery(api.context.read.read, { projectId, id: page.pageId });
  const sections = sectionsOf(read?.summary ?? "");
  const opening = openingOf(read?.summary ?? "").trim() || page.brief;
  const id = pageKey(page.pageId);
  const mentions = edges.filter((e) => e.kind === "mentions" && e.source === id).map((e) => e.target);
  const mentionedBy = edges
    .filter((e) => e.kind === "mentions" && e.target === id)
    .map((e) => e.source);
  const folder = data.folders.find((f) => f.folderId === page.folderId);
  const title = page.title.trim() || "Untitled";

  return (
    <div className="nt-ginfo-body">
      <button
        type="button"
        className="nt-ginfo-thumb"
        onClick={() => onOpen(page.pageId)}
        aria-label={`Open ${title}`}
      >
        <PagePreview docId={page.docId} />
      </button>

      <header className="nt-ginfo-head">
        <RowIcon icon={page.icon} kind="page" size={16} className="nt-ginfo-glyph" />
        <h2 className="nt-ginfo-title">{title}</h2>
      </header>

      <div className="nt-ginfo-byline">
        {page.owner && <Face name={page.owner.name} imageUrl={page.owner.imageUrl} />}
        <span>
          {page.owner ? `${page.owner.name}, ` : ""}edited {when(page.updatedAt)}
        </span>
      </div>

      {opening ? (
        <p className="nt-ginfo-brief">{opening}</p>
      ) : (
        <p className="nt-ginfo-note">
          No words in context yet. Open the page and what it says joins the next
          time it is saved.
        </p>
      )}

      {sections.length > 0 && (
        <section className="nt-ginfo-section">
          <h3 className="nt-ginfo-label">Sections</h3>
          <ol className="nt-ginfo-outline">
            {sections.map((s, i) => (
              <li key={`${i}:${s}`}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      <Links title="Mentions" ids={mentions} data={data} onSelect={onSelect} />
      <Links title="Mentioned by" ids={mentionedBy} data={data} onSelect={onSelect} />

      {folder && (
        <section className="nt-ginfo-section">
          <h3 className="nt-ginfo-label">In</h3>
          <button
            type="button"
            className="nt-row w-full"
            onClick={() => onSelect(folderKey(folder.folderId))}
          >
            <RowIcon icon={folder.icon} kind="folder" />
            <span className="nt-row-label">{folder.title.trim() || "Untitled folder"}</span>
          </button>
        </section>
      )}

      <div className="nt-ginfo-actions">
        <button
          type="button"
          className="nt-row nt-solid justify-center px-3 font-medium"
          onClick={() => onOpen(page.pageId)}
        >
          Open page
        </button>
      </div>
    </div>
  );
}

/** Rows for other nodes, each one a way to walk the graph from here. */
function Links({
  title,
  ids,
  data,
  onSelect,
}: {
  title: string;
  ids: readonly string[];
  data: GraphData;
  onSelect: (id: string) => void;
}) {
  if (!ids.length) return null;
  const pages = new Map(data.pages.map((p) => [pageKey(p.pageId), p]));
  const folders = new Map(data.folders.map((f) => [folderKey(f.folderId), f]));
  return (
    <section className="nt-ginfo-section">
      <h3 className="nt-ginfo-label">
        {title}
        <span className="nt-ginfo-count">{ids.length}</span>
      </h3>
      <ul className="nt-ginfo-links">
        {ids.map((id) => {
          const page = pages.get(id);
          const folder = folders.get(id);
          if (!page && !folder) return null;
          return (
            <li key={id}>
              <button type="button" className="nt-ginfo-link" onClick={() => onSelect(id)}>
                <RowIcon
                  icon={page?.icon ?? folder?.icon}
                  kind={folder ? "folder" : "page"}
                  className="nt-row-icon"
                />
                <span className="nt-ginfo-link-text">
                  <span className="nt-ginfo-link-title">
                    {(page?.title ?? folder?.title ?? "").trim() ||
                      (folder ? "Untitled folder" : "Untitled")}
                  </span>
                  {page?.brief && <span className="nt-ginfo-link-brief">{page.brief}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Face({ name, imageUrl }: { name: string; imageUrl?: string }) {
  return (
    <span className="nt-ginfo-face" aria-hidden>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" width={20} height={20} referrerPolicy="no-referrer" />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}
