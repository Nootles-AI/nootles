"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog } from "@/app/components/Dialog";
import { Check, ChevronRight, FileDoc, RotateCcw } from "@/app/components/Icons";
import type { NotionPageNode } from "@/app/lib/notion/plan";
import {
  runImport,
  type ImportProgress,
  type PageProgress,
} from "@/app/lib/notion/importRun";
import "./notion.css";

/**
 * Bringing pages over from Notion.
 *
 * One surface that changes state rather than a numbered wizard: connect, pick,
 * import, read what happened. The steps are not worth naming because you never
 * go back to one — each answer replaces the question, the way the paywall grows
 * in place instead of navigating.
 *
 * The state this surface exists to make honest is the one nobody expects:
 * Notion's consent screen decides which pages we can see, not this list. A user
 * who granted one page and sees one page has not hit a bug, and the way back to
 * Notion has to be visible at all times rather than appearing only when the
 * list is empty — by then they have already decided the import is broken.
 */
export function NotionImport({
  target,
  onClose,
}: {
  /** Absent creates a new project; present imports into that one. */
  target?: { projectId: Id<"projects">; folderId?: Id<"folders">; projectTitle: string };
  onClose: () => void;
}) {
  return (
    <Dialog label="Import from Notion" onClose={onClose}>
      {(close) => <Body target={target} close={close} />}
    </Dialog>
  );
}

function Body({
  target,
  close,
}: {
  target?: { projectId: Id<"projects">; folderId?: Id<"folders">; projectTitle: string };
  close: () => void;
}) {
  const client = useConvex();
  const status = useQuery(api.notion.account.status, {});
  const listPages = useAction(api.notion.pages.listPages);

  const [roots, setRoots] = useState<NotionPageNode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [projectTitle, setProjectTitle] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const abort = useRef<AbortController | null>(null);

  const connected = !!status?.account && !status.account.invalidAt;

  const load = useCallback(async () => {
    setLoadError(null);
    setRoots(null);
    try {
      setRoots(await listPages({}));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Notion could not be reached.");
    }
  }, [listPages]);

  // The tree is fetched, not derived — an action's result arriving later, which
  // is the same shape as the sanctioned subscription sets elsewhere (see
  // `useYjsEditor`). It cannot be computed during render because `connected`
  // only becomes true once the status query resolves.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => () => abort.current?.abort(), []);

  const count = selection.size;
  const running = progress?.phase === "creating" || progress?.phase === "importing";

  const start = async () => {
    if (!roots || !count) return;
    const controller = new AbortController();
    abort.current = controller;
    await runImport({
      client,
      roots,
      selection,
      ...(target ? { projectId: target.projectId, folderId: target.folderId } : {}),
      newProjectTitle: projectTitle.trim() || `${workspace} import`,
      onProgress: setProgress,
      signal: controller.signal,
    });
  };

  // ---- Connect ------------------------------------------------------------
  if (status && !connected) {
    return (
      <Shell
        title="Import from Notion"
        note={
          status.account?.invalidAt
            ? "Nootles no longer has access to this Notion account. Reconnecting takes a moment."
            : "Connect a Notion account to bring pages across. You choose which pages Nootles can see."
        }
        foot={
          <>
            <button type="button" onClick={close} className="nt-row px-2.5">
              Cancel
            </button>
            <a
              href={`/api/notion/connect?returnTo=${encodeURIComponent(returnHere())}`}
              className="nt-row nt-solid px-3 font-medium"
            >
              {status.account?.invalidAt ? "Reconnect Notion" : "Connect Notion"}
            </a>
          </>
        }
      >
        {!status.ready && <p className="nt-note">{status.blocker}</p>}
      </Shell>
    );
  }

  // ---- Report -------------------------------------------------------------
  if (progress && (progress.phase === "done" || progress.phase === "failed")) {
    return <Report progress={progress} close={close} />;
  }

  // ---- Running ------------------------------------------------------------
  if (progress && running) {
    const done = progress.pages.filter((p) => p.state === "done" || p.state === "failed").length;
    return (
      <Shell
        title="Importing"
        note={`${done} of ${progress.pages.length} pages. Keep this tab open — pages are written from here.`}
        foot={
          <button
            type="button"
            onClick={() => abort.current?.abort()}
            className="nt-row px-2.5"
          >
            Stop
          </button>
        }
      >
        <ol className="nt-notion-runlist">
          {progress.pages.map((page) => (
            <RunRow key={page.notionId} page={page} />
          ))}
        </ol>
      </Shell>
    );
  }

  // ---- Pick ---------------------------------------------------------------
  const workspace = status?.account?.workspaceName ?? "Notion";
  return (
    <Shell
      title={target ? `Import into ${target.projectTitle}` : "Import from Notion"}
      note={
        roots && roots.length
          ? `Pages ${workspace} shared with Nootles. Missing something? Grant it in Notion.`
          : undefined
      }
      foot={
        <>
          <a
            href={`/api/notion/connect?returnTo=${encodeURIComponent(returnHere())}`}
            className="nt-row px-2.5 mr-auto"
          >
            <RotateCcw />
            Grant more pages
          </a>
          <button type="button" onClick={close} className="nt-row px-2.5">
            Cancel
          </button>
          <button
            type="button"
            onClick={start}
            disabled={!count}
            className="nt-row nt-solid px-3 font-medium"
          >
            {count ? `Import ${count} ${count === 1 ? "page" : "pages"}` : "Import"}
          </button>
        </>
      }
    >
      {!target && (
        <div className="mb-3">
          <label className="nt-field-label" htmlFor="ni-title">
            New project
          </label>
          <input
            id="ni-title"
            className="nt-input"
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            placeholder={`${workspace} import`}
          />
        </div>
      )}

      {loadError && (
        <p className="nt-notion-error">
          {loadError}{" "}
          <button type="button" onClick={() => void load()} className="underline">
            Try again
          </button>
        </p>
      )}

      {!roots && !loadError && <TreeSkeleton />}

      {roots && roots.length === 0 && (
        <div className="nt-notion-empty">
          <p className="font-medium">No pages shared yet</p>
          <p className="nt-note mt-1">
            Notion asks which pages an app may read while you connect it. Grant a page there
            and it appears here.
          </p>
        </div>
      )}

      {roots && roots.length > 0 && (
        <div className="nt-notion-tree" role="tree">
          {roots.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              selection={selection}
              setSelection={setSelection}
            />
          ))}
        </div>
      )}
    </Shell>
  );
}

/** The dialog's own frame, so every state shares one geometry. */
function Shell({
  title,
  note,
  children,
  foot,
}: {
  title: string;
  note?: string;
  children?: React.ReactNode;
  foot: React.ReactNode;
}) {
  return (
    <>
      <div className="nt-dialog-head">
        <p className="text-sm font-medium">{title}</p>
        {note && <p className="mt-1.5 text-[13px] text-muted">{note}</p>}
      </div>
      <div className="nt-notion-body">{children}</div>
      <div className="nt-dialog-foot">{foot}</div>
    </>
  );
}

function TreeRow({
  node,
  depth,
  selection,
  setSelection,
}: {
  node: NotionPageNode;
  depth: number;
  selection: ReadonlySet<string>;
  setSelection: (next: ReadonlySet<string>) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const checked = selection.has(node.id);
  const descendants = useMemo(() => ids(node).slice(1), [node]);
  const someChildren = descendants.some((id) => selection.has(id));

  const toggle = () => {
    const next = new Set(selection);
    // Ticking a page takes what is under it: the pages inside a Notion page are
    // the reason you wanted it, and hunting them one by one is not a decision
    // anybody is trying to make.
    const all = [node.id, ...descendants];
    if (checked) all.forEach((id) => next.delete(id));
    else all.forEach((id) => next.add(id));
    setSelection(next);
  };

  return (
    <>
      <div className="nt-notion-row" style={{ paddingLeft: `${depth * 18}px` }}>
        {node.children.length ? (
          <button
            type="button"
            className="nt-notion-twist"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            data-open={open || undefined}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight />
          </button>
        ) : (
          <span className="nt-notion-twist-gap" />
        )}

        <button
          type="button"
          role="treeitem"
          aria-selected={checked}
          className="nt-notion-pick"
          onClick={toggle}
        >
          <span
            className="nt-notion-box"
            data-state={checked ? "on" : someChildren ? "partial" : "off"}
          >
            {checked && <Check />}
          </span>
          <span className="nt-notion-glyph" aria-hidden>
            {node.emoji ? <span className="nt-notion-emoji">{node.emoji}</span> : <FileDoc />}
          </span>
          <span className="nt-notion-title">{node.title}</span>
          {node.children.length > 0 && (
            <span className="nt-notion-count">{node.children.length}</span>
          )}
        </button>
      </div>
      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selection={selection}
            setSelection={setSelection}
          />
        ))}
    </>
  );
}

function RunRow({ page }: { page: PageProgress }) {
  return (
    <li className="nt-notion-run" data-state={page.state}>
      <span className="nt-notion-run-mark" aria-hidden>
        {page.state === "done" ? <Check /> : <FileDoc />}
      </span>
      <span className="nt-notion-title">{page.title}</span>
      <span className="nt-notion-run-state">{runLabel(page)}</span>
    </li>
  );
}

function runLabel(page: PageProgress): string {
  switch (page.state) {
    case "waiting":
      return "Waiting";
    case "fetching":
      return "Reading Notion";
    case "copying":
      return "Copying files";
    case "writing":
      return "Writing";
    case "failed":
      return page.error ?? "Failed";
    default:
      return `${page.blocks ?? 0} blocks`;
  }
}

/**
 * What each page lost on the way in.
 *
 * Summary first, detail on request. Most imports are clean, and opening on a
 * list of every flattened column would make a faithful import look damaged;
 * but a page that quietly lost its columns and never said so is the thing that
 * makes an importer untrustworthy the first time somebody notices.
 */
function Report({ progress, close }: { progress: ImportProgress; close: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const pages = progress.pages;
  const failed = pages.filter((p) => p.state === "failed").length;
  const blocks = pages.reduce((total, page) => total + (page.blocks ?? 0), 0);
  const changed = pages.filter((p) => noted(p) > 0).length;

  return (
    <Shell
      title={progress.phase === "failed" ? "Import stopped" : "Imported"}
      note={
        progress.error ??
        `${pages.length - failed} ${pages.length - failed === 1 ? "page" : "pages"}, ${blocks} blocks.` +
          (changed ? ` ${changed} changed on the way in.` : " Nothing was lost.") +
          (failed ? ` ${failed} failed.` : "")
      }
      foot={
        <button type="button" onClick={close} className="nt-row nt-solid px-3 font-medium">
          Done
        </button>
      }
    >
      <ul className="nt-notion-report">
        {pages.map((page) => {
          const notes = noted(page);
          const expandable = notes > 0 || page.state === "failed";
          const isOpen = open === page.notionId;
          return (
            <li key={page.notionId} className="nt-notion-reported" data-state={page.state}>
              <button
                type="button"
                className="nt-notion-reported-head"
                disabled={!expandable}
                aria-expanded={expandable ? isOpen : undefined}
                onClick={() => setOpen(isOpen ? null : page.notionId)}
              >
                {expandable ? (
                  <span className="nt-notion-twist" data-open={isOpen || undefined}>
                    <ChevronRight />
                  </span>
                ) : (
                  <span className="nt-notion-twist-gap" />
                )}
                <span className="nt-notion-title">{page.title}</span>
                <span className="nt-notion-run-state">
                  {page.state === "failed"
                    ? "Failed"
                    : notes
                      ? `${page.blocks} blocks, ${notes} noted`
                      : `${page.blocks} blocks`}
                </span>
              </button>
              {isOpen && (
                <dl className="nt-notion-detail">
                  {page.state === "failed" && (
                    <div>
                      <dt>Failed</dt>
                      <dd>{page.error}</dd>
                    </div>
                  )}
                  {Object.entries(page.issues ?? {}).map(([code, n]) => (
                    <div key={code}>
                      <dt>{describe(code)}</dt>
                      <dd>{n}</dd>
                    </div>
                  ))}
                  {!!page.lostMedia && (
                    <div>
                      <dt>Files Notion would not hand over</dt>
                      <dd>{page.lostMedia}</dd>
                    </div>
                  )}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}

const noted = (page: PageProgress) =>
  Object.values(page.issues ?? {}).reduce((a, b) => a + b, 0) + (page.lostMedia ?? 0);

/** Diagnostic codes as sentences. An unknown code shows itself rather than nothing. */
function describe(code: string): string {
  const said: Record<string, string> = {
    children_flattened: "Nested content moved below its parent",
    depth_limit_flattened: "Nesting deeper than four levels flattened",
    columns_flattened: "Columns laid out one after another",
    colour_dropped: "Text colour dropped",
    callout_as_quote: "Callouts became quotes",
    toggle_heading_flattened: "Toggle headings became plain headings",
    row_header_dropped: "Header column became an ordinary column",
    code_language_unmapped: "Code language has no highlighter here",
    code_caption_dropped: "Code captions dropped",
    preview_as_link: "Bookmarks and embeds became links",
    mention_flattened: "Mentions became plain text",
    mention_database: "Database mentions became links",
    mention_outside_import: "Links to pages you did not import",
    page_outside_import: "Links to pages you did not import",
    navigation_dropped: "Table of contents and breadcrumbs left out",
    notion_block_stubbed: "Blocks Nootles cannot hold yet",
    caption_flattened: "Formatted captions became plain text",
    unsafe_link_dropped: "Links Nootles will not follow",
    link_around_equation: "Links around equations dropped",
  };
  return said[code] ?? code.replace(/_/g, " ");
}

function TreeSkeleton() {
  return (
    <div className="nt-notion-tree" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="nt-notion-skel" style={{ width: `${58 + ((i * 13) % 30)}%` }} />
      ))}
    </div>
  );
}

function ids(node: NotionPageNode): string[] {
  return [node.id, ...node.children.flatMap(ids)];
}

function returnHere(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search;
}
