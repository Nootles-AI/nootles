"use client";

import { useRef, useState, type ReactNode } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ABOUT } from "@/convex/ai/questions";
import { CONTEXT_FILE_ACCEPT } from "@/convex/files/shared";
import type { Listed } from "@/convex/github/repos";
import { fileSize, uploadContextFile } from "@/app/lib/contextFiles";
import { when } from "@/app/lib/projectMeta";
import { FileDoc, Quote, X } from "../Icons";
import { NotionMark } from "../NotionMark";
import { GitHubPicker } from "./GitHubPicker";
import { GitHubMark } from "./marks";
import { NotionPicker, type NotionChoice } from "./NotionPicker";
import "./sources.css";

/**
 * Where a project's context comes from: three doors — a file, a GitHub
 * repository, a Notion page — and a card for everything that came through
 * them. No freeform text: what the assistant knows about a project is what the
 * project is made of, read from where it already lives.
 *
 * Two owners of the same picture. In a project, every card is a row written
 * the moment it is added (`ContextSources`); in the new-project dialog the
 * project does not exist yet, so the choices are held until it does
 * (`DraftSources`).
 */

type Source = "file" | "github" | "notion" | "note";

export type Card = {
  key: string;
  source: Source;
  title: string;
  /** What the card has to say: its size, how far reading has got, why it failed. */
  line?: string;
  state?: "busy" | "ok" | "problem";
  onRemove?: () => void;
};

type Door = "github" | "notion";

/** The doors and the cards, owning nothing — the two callers own the lists. */
function Sources({
  cards,
  linkedRepos,
  linkedPages,
  onFiles,
  onRepo,
  onPages,
  busy,
  failure,
  empty,
}: {
  cards: Card[];
  linkedRepos: ReadonlySet<string>;
  linkedPages: ReadonlySet<string>;
  onFiles: (files: File[]) => void;
  onRepo: (repo: Listed) => void;
  onPages: (pages: NotionChoice[]) => void;
  busy?: boolean;
  failure?: string | null;
  empty: string;
}) {
  const [door, setDoor] = useState<Door | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const toggle = (next: Door) => setDoor((d) => (d === next ? null : next));

  return (
    <div className="nt-sources">
      <div className="nt-sources-doors" role="toolbar" aria-label="Add context from">
        <DoorButton label="Upload a file" onClick={() => input.current?.click()} busy={busy}>
          <FileDoc width={16} height={16} />
        </DoorButton>
        <DoorButton
          label="Add a GitHub repository"
          onClick={() => toggle("github")}
          pressed={door === "github"}
        >
          <GitHubMark width={15} height={15} />
        </DoorButton>
        <DoorButton
          label="Add Notion pages"
          onClick={() => toggle("notion")}
          pressed={door === "notion"}
        >
          <NotionMark width={16} height={16} />
        </DoorButton>
        <input
          ref={input}
          type="file"
          multiple
          accept={CONTEXT_FILE_ACCEPT}
          className="hidden"
          aria-label="Upload a file to the project's context"
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (chosen.length) onFiles(chosen);
          }}
        />
      </div>

      {door === "github" && (
        <GitHubPicker
          linked={linkedRepos}
          onPick={(repo) => {
            onRepo(repo);
            setDoor(null);
          }}
          onDone={() => setDoor(null)}
        />
      )}
      {door === "notion" && (
        <NotionPicker linked={linkedPages} onAdd={onPages} onDone={() => setDoor(null)} />
      )}

      {failure && (
        <p role="alert" className="nt-sources-failure">
          {failure}
        </p>
      )}

      {cards.length ? (
        <ul className="nt-src-cards">
          {cards.map((card) => (
            <ContextCard key={card.key} card={card} />
          ))}
        </ul>
      ) : (
        <p className="nt-sources-empty">{empty}</p>
      )}
    </div>
  );
}

function DoorButton({
  label,
  onClick,
  pressed,
  busy,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      className="nt-door"
    >
      {children}
    </button>
  );
}

const MARKS: Record<Source, ReactNode> = {
  file: <FileDoc width={15} height={15} />,
  github: <GitHubMark width={14} height={14} />,
  notion: <NotionMark width={15} height={15} />,
  note: <Quote width={15} height={15} />,
};

function ContextCard({ card }: { card: Card }) {
  return (
    <li className={`nt-src-card${card.state ? ` is-${card.state}` : ""}`}>
      <span className="nt-src-mark" aria-hidden>
        {MARKS[card.source]}
      </span>
      <span className="nt-src-text">
        <span className="nt-src-title" title={card.title}>
          {card.title}
        </span>
        {card.line && <span className="nt-src-line">{card.line}</span>}
      </span>
      {card.onRemove && (
        <button
          type="button"
          onClick={card.onRemove}
          aria-label={`Remove ${card.title} from the context`}
          title="Remove"
          className="nt-src-remove"
        >
          <X width={12} height={12} />
        </button>
      )}
    </li>
  );
}

// ---- In a project ----------------------------------------------------------

/** A project's sources, each card a row written the moment it is added. */
export function ContextSources({ projectId }: { projectId: Id<"projects"> }) {
  const convex = useConvex();
  const repos = useQuery(api.github.repos.listForProject, { projectId });
  const files = useQuery(api.files.context.listForProject, { projectId });
  const pages = useQuery(api.notion.context.listForProject, { projectId });
  const notes = useQuery(api.ai.context.list, { projectId });
  const linkRepo = useMutation(api.github.repos.link);
  const unlinkRepo = useMutation(api.github.repos.unlink);
  const removeFile = useMutation(api.files.context.remove);
  const linkPages = useMutation(api.notion.context.link);
  const unlinkPage = useMutation(api.notion.context.unlink);
  const removeNote = useMutation(api.ai.context.remove);
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const cards: Card[] = [
    ...(repos ?? []).map(
      (r): Card => ({
        key: r._id,
        source: "github",
        title: r.fullName,
        line: repoLine(r.index),
        state: stateOf(r.index?.state),
        onRemove: () => void unlinkRepo({ repoId: r._id }),
      }),
    ),
    ...(pages ?? []).map(
      (p): Card => ({
        key: p._id,
        source: "notion",
        title: `${p.emoji ? `${p.emoji} ` : ""}${p.title || "Untitled"}`,
        line: pageLine(p.index),
        state: p.index.state === "failed" ? "problem" : p.index.state === "ready" ? "ok" : "busy",
        onRemove: () => void unlinkPage({ rowId: p._id }),
      }),
    ),
    ...(files ?? []).map(
      (f): Card => ({
        key: f._id,
        source: "file",
        title: f.filename,
        line: f.syncError ?? (f.syncedAt ? fileSize(f.size) : "Reading…"),
        state: f.syncError ? "problem" : f.syncedAt ? "ok" : "busy",
        onRemove: () => void removeFile({ fileId: f._id }),
      }),
    ),
    // What was written before context came from sources: kept, and removable.
    ...(notes ?? [])
      .filter((n) => n.question !== ABOUT && n.answer?.trim())
      .map(
        (n): Card => ({
          key: n._id,
          source: "note",
          title: "Note",
          line: n.answer!.trim(),
          state: "ok",
          onRemove: () => void removeNote({ id: n._id }),
        }),
      ),
  ];

  return (
    <Sources
      cards={cards}
      linkedRepos={new Set((repos ?? []).map((r) => r.fullName))}
      linkedPages={new Set((pages ?? []).map((p) => p.pageId))}
      busy={uploading}
      failure={failure}
      empty="Nothing added yet. Files, repositories and Notion pages added here are read before the assistant answers."
      onFiles={(chosen) => {
        setUploading(true);
        setFailure(null);
        void (async () => {
          try {
            for (const file of chosen) await uploadContextFile(convex, projectId, file);
          } catch (error) {
            setFailure(error instanceof Error ? error.message : "That file could not be added.");
          } finally {
            setUploading(false);
          }
        })();
      }}
      onRepo={(repo) => void linkRepo({ projectId, repos: [repoRef(repo)] })}
      onPages={(chosen) => void linkPages({ projectId, pages: chosen })}
    />
  );
}

// ---- Before a project exists -----------------------------------------------

export type DraftSourcesValue = {
  repos: Listed[];
  files: File[];
  pages: NotionChoice[];
};

/** The new-project dialog's sources, held until the project exists to take them. */
export function DraftSources({
  value,
  onChange,
}: {
  value: DraftSourcesValue;
  onChange: (next: DraftSourcesValue) => void;
}) {
  const cards: Card[] = [
    ...value.repos.map(
      (r): Card => ({
        key: `r:${r.fullName}`,
        source: "github",
        title: r.fullName,
        line: r.private ? "Private repository" : "Public repository",
        onRemove: () => onChange({ ...value, repos: value.repos.filter((x) => x !== r) }),
      }),
    ),
    ...value.pages.map(
      (p): Card => ({
        key: `n:${p.pageId}`,
        source: "notion",
        title: `${p.emoji ? `${p.emoji} ` : ""}${p.title}`,
        line: "Notion page",
        onRemove: () => onChange({ ...value, pages: value.pages.filter((x) => x !== p) }),
      }),
    ),
    ...value.files.map(
      (f, i): Card => ({
        key: `f:${i}:${f.name}`,
        source: "file",
        title: f.name,
        line: fileSize(f.size),
        onRemove: () => onChange({ ...value, files: value.files.filter((x) => x !== f) }),
      }),
    ),
  ];
  return (
    <Sources
      cards={cards}
      linkedRepos={new Set(value.repos.map((r) => r.fullName))}
      linkedPages={new Set(value.pages.map((p) => p.pageId))}
      empty="Add files, repositories or Notion pages. They are read into the project once it is made."
      onFiles={(chosen) => onChange({ ...value, files: [...value.files, ...chosen] })}
      onRepo={(repo) => onChange({ ...value, repos: [...value.repos, repo] })}
      onPages={(chosen) => onChange({ ...value, pages: [...value.pages, ...chosen] })}
    />
  );
}

// ---- Lines ------------------------------------------------------------------

type RepoIndex = {
  state: "queued" | "indexing" | "naming" | "ready" | "failed";
  error?: string;
  files?: number;
  concerns?: number;
  at?: number;
};

/** Where a repository's reading stands, in a line. */
export function repoLine(index: RepoIndex | undefined | null): string | undefined {
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

function pageLine(index: { state: string; error?: string; at?: number }): string {
  if (index.state === "failed") return index.error ?? "Could not be read";
  if (index.state === "ready") return index.at ? `Read ${when(index.at)}` : "Read";
  return "Reading…";
}

function stateOf(state: RepoIndex["state"] | undefined): Card["state"] {
  if (state === "failed") return "problem";
  if (state === "ready" || !state) return "ok";
  return "busy";
}

export function repoRef(repo: Listed) {
  return {
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    ...(repo.description ? { description: repo.description } : {}),
    private: repo.private,
  };
}
