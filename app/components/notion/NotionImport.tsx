"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAction, useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog } from "@/app/components/Dialog";
import { Check, ChevronRight, FileDoc, Search } from "@/app/components/Icons";
import type { NotionPageNode } from "@/app/lib/notion/plan";
import {
  importFraction,
  runImport,
  type ImportProgress,
  type PageProgress,
} from "@/app/lib/notion/importRun";
import { NotionConnect } from "./NotionConnect";
import { ids, matchingPages, NotionPageTree } from "./NotionPageTree";
import { PickSide } from "./PickSide";
import { PageStep, ProgressBar } from "./Progress";
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
    <Dialog labelledBy={TITLE_ID} onClose={onClose}>
      {(close) => <NotionImportBody target={target} close={close} />}
    </Dialog>
  );
}

/** The shell's title names the dialog, so the name changes as the state does. */
const TITLE_ID = "nt-notion-title";

/**
 * The import itself, in whichever frame holds it.
 *
 * One state machine for both: the dialog the sidebar opens to import into a
 * project, and the projects screen's palette, where it is the last page of
 * "New project". The frames differ in dress and in what leaving means — in the
 * palette, giving up is a step back to the ways to start, while finishing closes
 * the palette — so `back` and `close` are separate, and the same in the dialog.
 */
export function NotionImportBody({
  target,
  close,
  back = close,
  frame = "dialog",
  search,
  onSearchable,
}: {
  target?: { projectId: Id<"projects">; folderId?: Id<"folders">; projectTitle: string };
  /** Finished: leave the whole surface. */
  close: () => void;
  /** Given up: in the palette, the page before this one. */
  back?: () => void;
  frame?: "dialog" | "palette";
  /**
   * The query, when the host has a search field of its own — the palette's top
   * field. Given, the pick state draws no field and filters by this instead.
   */
  search?: string;
  /** Whether there is a list to search right now, so the host can offer its field. */
  onSearchable?: (searchable: boolean) => void;
}) {
  const inPalette = frame === "palette";
  const Frame = inPalette ? PaletteShell : Shell;
  const leave = inPalette ? "Back" : "Cancel";
  const client = useConvex();
  const status = useQuery(api.notion.account.status, {});
  const listPages = useAction(api.notion.pages.listPages);

  const [roots, setRoots] = useState<NotionPageNode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [typed, setQuery] = useState("");
  const query = search ?? typed;
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [stopped, setStopped] = useState(false);
  // The page under the palette's highlight, which its side pane describes.
  const [current, setCurrent] = useState<string | null>(null);
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

  // Only the pick state, with pages in it, has anything to search.
  const searchable = connected && !progress && !!roots?.length;
  useEffect(() => onSearchable?.(searchable), [onSearchable, searchable]);

  const count = selection.size;
  const running = progress?.phase === "creating" || progress?.phase === "importing";
  const shown = useMemo(() => matchingPages(roots ?? [], query), [roots, query]);
  /**
   * The project takes the name of the page you picked.
   *
   * The topmost selected page in the tree's own order, which for the usual
   * import — one page and everything under it — is the thing you would have
   * typed anyway. Only a pick spanning several unrelated tops has no obvious
   * name, and then the workspace's is the honest one.
   */
  const derivedTitle = useMemo(() => {
    const first = roots ? topmostSelected(roots, selection) : undefined;
    return first ?? `${status?.account?.workspaceName ?? "Notion"} import`;
  }, [roots, selection, status]);

  const start = async () => {
    if (!roots || !count) return;
    const controller = new AbortController();
    abort.current = controller;
    setStopped(false);
    await runImport({
      client,
      roots,
      selection,
      ...(target ? { projectId: target.projectId, folderId: target.folderId } : {}),
      newProjectTitle: derivedTitle,
      onProgress: setProgress,
      signal: controller.signal,
    });
  };

  const stop = () => {
    abort.current?.abort();
    setStopped(true);
  };

  // ---- Asking ------------------------------------------------------------
  // The palette waits for the answer before drawing anything. Falling through
  // to the pick state's "Reading your Notion pages" for the beat before the
  // status arrives would promise a list to someone who has not connected.
  // What it draws meanwhile is the same bar the page list loads behind, so one
  // wait reads as one wait — but it only names the pages once it knows of any.
  const reading = (said: string) => (
    <PaletteShell said={said} title="" foot={<LeaveButton label={leave} onClick={back} />}>
      <div className="nt-pal-reading">
        <div className="nt-pal-reading-bar">
          <ProgressBar label={READING} />
          {said && <p aria-hidden>Fetching Notion pages…</p>}
        </div>
      </div>
    </PaletteShell>
  );
  if (inPalette && !status) return reading("");

  // ---- Connect ------------------------------------------------------------
  if (status && !connected && inPalette) {
    return (
      <PaletteShell said="" title="" foot={<LeaveButton label={leave} onClick={back} />}>
        <NotionConnect
          titleId={TITLE_ID}
          stale={!!status.account?.invalidAt}
          blocker={status.ready ? null : (status.blocker ?? null)}
          href={`/api/notion/connect?returnTo=${encodeURIComponent(returnHere())}`}
        />
      </PaletteShell>
    );
  }
  if (status && !connected) {
    return (
      <Shell
        said=""
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
            {/* No button to a connection this deployment cannot keep: the
                sentence below says what is missing instead. */}
            {status.ready && (
              <a
                href={`/api/notion/connect?returnTo=${encodeURIComponent(returnHere())}`}
                className="nt-row nt-solid px-3 font-medium"
              >
                {status.account?.invalidAt ? "Reconnect Notion" : "Connect Notion"}
              </a>
            )}
          </>
        }
      >
        {!status.ready && <p className="nt-note">{status.blocker}</p>}
      </Shell>
    );
  }

  // ---- Report -------------------------------------------------------------
  if (progress && (progress.phase === "done" || progress.phase === "failed")) {
    const landed = progress.pages.filter((p) => p.state === "done").length;
    const note = summarise(progress);
    return (
      <Frame
        said={note}
        title={
          progress.phase === "failed" ? "Import stopped" : landed ? "Imported" : "Nothing imported"
        }
        note={note}
        foot={
          <button
            type="button"
            onClick={close}
            autoFocus
            className="nt-row nt-solid px-3 font-medium"
          >
            Done
          </button>
        }
      >
        <Report progress={progress} />
      </Frame>
    );
  }

  // ---- Running ------------------------------------------------------------
  if (progress && running) {
    const total = progress.pages.length;
    const done = progress.pages.filter((p) => p.state === "done" || p.state === "failed").length;
    const pages = total === 1 ? "page" : "pages";
    const tally = stopped
      ? "Stopping. Unfinished pages are being removed."
      : progress.phase === "creating"
        ? `Creating ${total} ${pages}`
        : `${done} of ${total} ${pages}`;
    return (
      <Frame
        said={tally}
        title="Importing"
        note="Keep this tab open — pages are written from here."
        bar={<ProgressBar value={importFraction(progress)} label="Import progress" />}
        foot={
          // Still focusable once pressed: a button that disables itself under
          // the finger drops focus to the page, and the report that follows
          // would then arrive with nothing focused.
          <button
            type="button"
            onClick={() => !stopped && stop()}
            aria-disabled={stopped || undefined}
            autoFocus
            className="nt-row px-2.5"
          >
            {stopped ? "Stopping…" : "Stop"}
          </button>
        }
      >
        <p className="nt-notion-live">{tally}</p>
        <ol className="nt-notion-runlist">
          {progress.pages.map((page) => (
            <RunRow key={page.notionId} page={page} />
          ))}
        </ol>
      </Frame>
    );
  }

  // ---- Pick ---------------------------------------------------------------
  const workspace = status?.account?.workspaceName ?? "Notion";
  const loading = !roots && !loadError;
  const lands =
    count && !target ? `Lands in a new project called “${derivedTitle}”.` : null;

  if (inPalette && loading) return reading(READING);

  // In the palette the list and its side pane are the palette's own two panes,
  // and what the dialog says in a sentence under its title is said there.
  if (inPalette && roots && roots.length > 0) {
    const at = current ? locate(roots, current) : null;
    return (
      <PaletteShell
        said=""
        title={target ? `Import into ${target.projectTitle}` : ""}
        flush
        foot={
          <>
            <a
              href={`/api/notion/connect?returnTo=${encodeURIComponent(returnHere())}`}
              className="nt-row px-2.5 mr-auto"
            >
              Grant more pages
            </a>
            <LeaveButton label={leave} onClick={back} />
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
        <div className="nt-pal-panes">
          <div className="nt-pal-list nt-pal-picklist">
            <div className="nt-pal-group">Shared from {workspace}</div>
            <NotionPageTree
              nodes={shown}
              selection={selection}
              setSelection={setSelection}
              forceOpen={!!query}
              palette
              onCurrent={setCurrent}
            />
          </div>
          <PickSide
            node={at?.node ?? null}
            path={at?.path ?? []}
            state={
              !at
                ? "off"
                : selection.has(at.node.id)
                  ? "on"
                  : ids(at.node).some((id) => selection.has(id))
                    ? "partial"
                    : "off"
            }
            count={count}
            lands={lands}
          />
        </div>
      </PaletteShell>
    );
  }

  return (
    <Frame
      said={loading ? READING : ""}
      // The palette's crumbs already read "Import from Notion".
      title={target ? `Import into ${target.projectTitle}` : inPalette ? "" : "Import from Notion"}
      note={
        roots && roots.length
          ? lands
            ? lands
            : `Pages shared with Nootles from ${workspace}. Missing one? Grant it in Notion.`
          : undefined
      }
      foot={
        <>
          <a
            href={`/api/notion/connect?returnTo=${encodeURIComponent(returnHere())}`}
            className="nt-row px-2.5 mr-auto"
          >
            Grant more pages
          </a>
          <LeaveButton label={leave} onClick={back} />
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
      {!!roots?.length && search === undefined && (
        <div className="nt-notion-search">
          <Search className="nt-notion-search-icon" aria-hidden />
          <input
            className="nt-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages"
            aria-label="Search pages"
            autoFocus
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

      {loading && <p className="nt-notion-nomatch">{READING}…</p>}

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
        <NotionPageTree
          nodes={shown}
          selection={selection}
          setSelection={setSelection}
          // A search that hid its own results behind a twist would be no
          // search at all.
          forceOpen={!!query}
        />
      )}
    </Frame>
  );
}

const LeaveButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" onClick={onClick} className="nt-row px-2.5">
    {label}
  </button>
);

const READING = "Reading your Notion pages";

/**
 * The dialog's own frame, so every state shares one geometry — and one voice
 * for a screen reader: `said` is the sentence the state is announcing, read
 * from a region that stays mounted from the first state to the last, which is
 * why every state of `Body` renders this and nothing else at its root. A
 * region that lived only in the running state would vanish with it, and the
 * outcome — the one sentence worth hearing — would never be read.
 */
function Shell({
  said,
  title,
  note,
  bar,
  children,
  foot,
}: {
  said: string;
  title: string;
  /** The palette's alone; the dialog's body always keeps its padding. */
  flush?: boolean;
  note?: string;
  /** A progress bar, kept in the head so it reads as part of the title's claim. */
  bar?: ReactNode;
  children?: ReactNode;
  foot: ReactNode;
}) {
  return (
    <>
      <p className="sr-only" role="status">
        {said}
      </p>
      <div className="nt-dialog-head">
        <h2 id={TITLE_ID} className="text-sm font-medium">
          {title}
        </h2>
        {note && <p className="mt-1.5 text-[13px] text-muted">{note}</p>}
        {bar}
      </div>
      <div className="nt-notion-body">{children}</div>
      <div className="nt-dialog-foot">{foot}</div>
    </>
  );
}

/**
 * The same frame in the palette's dress: no box of its own, a head that is only
 * there when a state has something to say, and the palette's footer. It keeps
 * `Shell`'s one promise — the status region stays mounted across every state.
 */
function PaletteShell({
  said,
  title,
  note,
  bar,
  flush,
  children,
  foot,
}: {
  said: string;
  title: string;
  /** Children run to the edges: they are panes, not a padded body. */
  flush?: boolean;
  note?: string;
  bar?: ReactNode;
  children?: ReactNode;
  foot: ReactNode;
}) {
  // Stepping onto this page unmounts the palette's field, and with it whatever
  // had focus. A state with nothing of its own to focus — asking, reading —
  // would leave the keyboard on the document, where Escape closes the palette
  // instead of stepping back. The page itself takes it until something better
  // arrives.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={root} tabIndex={-1} className="nt-pal-form nt-pal-notion outline-none">
      <p className="sr-only" role="status">
        {said}
      </p>
      {(title || note || bar) && (
        <div className="nt-pal-nhead">
          {title && (
            <h2 id={TITLE_ID} className="nt-pal-ntitle">
              {title}
            </h2>
          )}
          {note && <p className="nt-pal-nnote">{note}</p>}
          {bar}
        </div>
      )}
      <div className={`nt-notion-body nt-pal-nbody${flush ? " is-flush" : ""}`}>{children}</div>
      <div className="nt-pal-foot">{foot}</div>
    </div>
  );
}

// ---- Running ---------------------------------------------------------------

function RunRow({ page }: { page: PageProgress }) {
  return (
    <li className="nt-notion-run" data-state={page.state}>
      <span className="nt-notion-run-mark" aria-hidden>
        {page.state === "done" ? <Check /> : <FileDoc />}
      </span>
      <span className="nt-notion-title">{page.title}</span>
      <span className="nt-notion-run-state">
        <PageStep page={page} />
      </span>
    </li>
  );
}

/**
 * What each page lost on the way in.
 *
 * Summary first, detail on request. Most imports are clean, and opening on a
 * list of every flattened column would make a faithful import look damaged;
 * but a page that quietly lost its columns and never said so is the thing that
 * makes an importer untrustworthy the first time somebody notices.
 */
function Report({ progress }: { progress: ImportProgress }) {
  const [open, setOpen] = useState<string | null>(null);
  const pages = progress.pages;

  return (
    <ul className="nt-notion-report">
      {pages.map((page) => {
        const notes = noted(page);
        const expandable = notes > 0 || !!page.error;
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
              <span className="nt-notion-run-state">{reportLabel(page, notes)}</span>
            </button>
            {isOpen && (
              <dl className="nt-notion-detail">
                {page.error && (
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
  );
}

/**
 * What the run amounted to, in one sentence.
 *
 * A page that failed is counted as failed whether or not it was then taken
 * back out — the removal is the tidy-up, not the outcome — and a page removed
 * only because the run was stopped is an unfinished one, not a failure.
 */
function summarise(progress: ImportProgress): string {
  const pages = progress.pages;
  const landed = pages.filter((p) => p.state === "done").length;
  const failed = pages.filter((p) => p.error).length;
  const unfinished = pages.filter((p) => p.state === "removed" && !p.error).length;
  const blocks = pages.reduce((total, page) => total + (page.blocks ?? 0), 0);
  const changed = pages.filter((p) => noted(p) > 0).length;
  const n = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;

  if (progress.error) {
    return (
      progress.error +
      (landed ? ` ${n(landed, "page")} kept.` : "") +
      (unfinished ? ` ${n(unfinished, "unfinished page")} removed.` : "") +
      (failed ? ` ${n(failed, "page")} failed.` : "")
    );
  }
  return (
    `${n(landed, "page")}, ${n(blocks, "block")}.` +
    (changed ? ` ${changed} changed on the way in.` : landed ? " Nothing was lost." : "") +
    (failed ? ` ${n(failed, "page")} failed and ${failed === 1 ? "was" : "were"} removed.` : "")
  );
}

function reportLabel(page: PageProgress, notes: number): string {
  // A page with an error failed, whether it is still there empty or was
  // taken back out; the strike-through says which.
  if (page.error) return "Failed";
  switch (page.state) {
    case "done":
      return notes ? `${page.blocks} blocks, ${notes} noted` : `${page.blocks} blocks`;
    case "removed":
      return "Removed";
    default:
      return "Not started";
  }
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


/** The first selected page in the tree's own order. */
function topmostSelected(
  nodes: NotionPageNode[],
  selection: ReadonlySet<string>,
): string | undefined {
  for (const node of nodes) {
    if (selection.has(node.id)) return node.title;
    const inside = topmostSelected(node.children, selection);
    if (inside) return inside;
  }
  return undefined;
}

/** A page and the titles of the pages it sits inside, outermost first. */
function locate(
  nodes: NotionPageNode[],
  id: string,
  path: string[] = [],
): { node: NotionPageNode; path: string[] } | null {
  for (const node of nodes) {
    if (node.id === id) return { node, path };
    const inside = locate(node.children, id, [...path, node.title]);
    if (inside) return inside;
  }
  return null;
}

function returnHere(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search;
}
