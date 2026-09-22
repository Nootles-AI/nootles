"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { when } from "@/app/lib/projectMeta";
import { PagePreview } from "../../PagePreview";
import { RowIcon } from "../../rowIcon";
import { ContextFields } from "../ContextFields";
import { GitHubRepos } from "../GitHubRepos";
import {
  codeKey,
  folderKey,
  openingOf,
  pageKey,
  sectionsOf,
  type GraphData,
  type GraphConcern,
  type GraphPage,
  type GraphRepo,
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
  if (node.kind === "repo") return <RepoInfo repo={node.repo} data={data} onSelect={onSelect} />;
  if (node.kind === "area") {
    const concerns = data.code.concerns.filter((c) => c.parentId === node.area.nodeId);
    return (
      <div className="nt-ginfo-body">
        <header>
          <h2 className="nt-ginfo-title">{node.area.title}</h2>
          <p className="nt-ginfo-meta">{node.area.brief}</p>
        </header>
        <CodeRows
          title="Concerns"
          rows={concerns.map((c) => ({ id: codeKey(c.nodeId), title: c.title, brief: c.brief }))}
          onSelect={onSelect}
        />
      </div>
    );
  }
  if (node.kind === "concern") {
    return <ConcernInfo projectId={projectId} concern={node.concern} onSelect={onSelect} />;
  }
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

      <section className="nt-ginfo-section">
        <Repositories projectId={projectId} />
      </section>

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

/**
 * The repositories feeding this project's context, and the way to add more —
 * the same picker the new-project dialog offers, writing straight away here.
 */
function Repositories({ projectId }: { projectId: Id<"projects"> }) {
  const repos = useQuery(api.github.repos.listForProject, { projectId });
  const link = useMutation(api.github.repos.link);
  const unlink = useMutation(api.github.repos.unlink);
  return (
    <GitHubRepos
      repos={(repos ?? []).map((r) => ({
        key: r._id,
        fullName: r.fullName,
        description: r.description,
        private: r.private,
        note: stateLine(r.index),
        noteIsProblem: r.index?.state === "failed",
      }))}
      onAdd={(repo) =>
        void link({
          projectId,
          repos: [
            {
              fullName: repo.fullName,
              defaultBranch: repo.defaultBranch,
              ...(repo.description ? { description: repo.description } : {}),
              private: repo.private,
            },
          ],
        })
      }
      onRemove={(key) => void unlink({ repoId: key as Id<"projectRepos"> })}
    />
  );
}

type IndexState = {
  state: "queued" | "indexing" | "naming" | "ready" | "failed";
  error?: string;
  files?: number;
  concerns?: number;
};

/** Where a repository's reading stands, in a line. */
function stateLine(index: IndexState | undefined | null): string | undefined {
  switch (index?.state) {
    case "queued":
      return "Waiting to be read";
    case "indexing":
      return "Reading the code…";
    case "naming":
      return "Naming what it found…";
    case "failed":
      return index.error ?? "Could not be read";
    case "ready":
      return index.files ? `${index.files} files in ${index.concerns ?? 0} concerns` : undefined;
    default:
      return undefined;
  }
}

function RepoInfo({
  repo,
  data,
  onSelect,
}: {
  repo: GraphRepo;
  data: GraphData;
  onSelect: (id: string) => void;
}) {
  const areas = data.code.areas.filter((a) => a.parentId === repo.nodeId);
  const busy = repo.state === "queued" || repo.state === "indexing";
  const line = stateLine({ state: repo.state, error: repo.error ?? undefined, files: repo.files });
  return (
    <div className="nt-ginfo-body">
      <header>
        <h2 className="nt-ginfo-title">{repo.fullName}</h2>
        {repo.description && <p className="nt-ginfo-lede">{repo.description}</p>}
      </header>
      {line && (
        <p className={repo.state === "failed" ? "nt-ginfo-note is-problem" : "nt-ginfo-meta"}>
          {line}
          {repo.indexedAt && repo.state === "ready" ? `, read ${when(repo.indexedAt)}` : ""}
        </p>
      )}
      <CodeRows
        title="Areas"
        rows={areas.map((a) => ({ id: codeKey(a.nodeId), title: a.title, brief: a.brief }))}
        onSelect={onSelect}
      />
      <div className="nt-ginfo-actions is-pair">
        <a href={repo.url} target="_blank" rel="noreferrer" className="nt-row justify-center px-3">
          Open on GitHub
        </a>
        <ReindexButton disabled={busy} repoId={repo.repoId as Id<"projectRepos">} />
      </div>
    </div>
  );
}

function ReindexButton({ disabled, repoId }: { disabled: boolean; repoId: Id<"projectRepos"> }) {
  const reindex = useMutation(api.github.repos.reindex);
  const [asked, setAsked] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || asked}
      onClick={() => {
        setAsked(true);
        void reindex({ repoId }).finally(() => setAsked(false));
      }}
      className="nt-row nt-solid justify-center px-3 font-medium"
    >
      {disabled ? "Reading…" : "Read again"}
    </button>
  );
}

function ConcernInfo({
  projectId,
  concern,
  onSelect,
}: {
  projectId: Id<"projects">;
  concern: GraphConcern;
  onSelect: (id: string) => void;
}) {
  const detail = useQuery(api.context.read.concern, {
    projectId,
    nodeId: concern.nodeId as Id<"contextNodes">,
  });
  return (
    <div className="nt-ginfo-body">
      <header className="nt-ginfo-head">
        {concern.styling && <span className="nt-gnode-swatch nt-ginfo-glyph" aria-hidden />}
        <h2 className="nt-ginfo-title">{concern.title}</h2>
      </header>
      <p className="nt-ginfo-brief">{concern.brief}</p>

      {concern.styling && detail?.summary && (
        <section className="nt-ginfo-section">
          <h3 className="nt-ginfo-label">What its screens are made of</h3>
          <pre className="nt-ginfo-facts">{detail.summary}</pre>
        </section>
      )}

      {detail && detail.related.length > 0 && (
        <CodeRows
          title="Works with"
          rows={detail.related.map((r) => ({ id: codeKey(r.nodeId), title: r.title, brief: "" }))}
          onSelect={onSelect}
        />
      )}

      {detail && detail.files.length > 0 && (
        <section className="nt-ginfo-section">
          <h3 className="nt-ginfo-label">
            Files
            <span className="nt-ginfo-count">{detail.files.length}</span>
          </h3>
          <ul className="nt-ginfo-links">
            {detail.files.map((f) => (
              <li key={f.path}>
                <a
                  href={f.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="nt-ginfo-link"
                >
                  <span className="nt-ginfo-link-text">
                    <span className="nt-ginfo-link-title is-path">{f.path}</span>
                    {f.brief && <span className="nt-ginfo-link-brief">{f.brief}</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Rows for code nodes — areas, concerns — each a step across the map. */
function CodeRows({
  title,
  rows,
  onSelect,
}: {
  title: string;
  rows: { id: string; title: string; brief: string }[];
  onSelect: (id: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <section className="nt-ginfo-section">
      <h3 className="nt-ginfo-label">
        {title}
        <span className="nt-ginfo-count">{rows.length}</span>
      </h3>
      <ul className="nt-ginfo-links">
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" className="nt-ginfo-link" onClick={() => onSelect(row.id)}>
              <span className="nt-ginfo-link-text">
                <span className="nt-ginfo-link-title">{row.title}</span>
                {row.brief && <span className="nt-ginfo-link-brief">{row.brief}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
