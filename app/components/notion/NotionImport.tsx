"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
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
      {(close) => <Body target={target} close={close} />}
    </Dialog>
  );
}

/** The shell's title names the dialog, so the name changes as the state does. */
const TITLE_ID = "nt-notion-title";

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
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [stopped, setStopped] = useState(false);
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
  const shown = useMemo(() => matching(roots ?? [], query), [roots, query]);
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

  // ---- Connect ------------------------------------------------------------
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
      <Shell
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
      </Shell>
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
      <Shell
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
      </Shell>
    );
  }

  // ---- Pick ---------------------------------------------------------------
  const workspace = status?.account?.workspaceName ?? "Notion";
  const loading = !roots && !loadError;
  return (
    <Shell
      said={loading ? READING : ""}
      title={target ? `Import into ${target.projectTitle}` : "Import from Notion"}
      note={
        roots && roots.length
          ? count && !target
            ? `Lands in a new project called “${derivedTitle}”.`
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
      {!!roots?.length && (
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
        <Tree
          nodes={shown}
          selection={selection}
          setSelection={setSelection}
          // A search that hid its own results behind a twist would be no
          // search at all.
          forceOpen={!!query}
        />
      )}
    </Shell>
  );
}

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

// ---- The pick tree ---------------------------------------------------------

type Row = {
  node: NotionPageNode;
  depth: number;
  parent?: string;
  open: boolean;
  /** Its place among its siblings, which a flat list of rows cannot otherwise say. */
  pos: number;
  size: number;
};

/**
 * The tree as the flat list of rows it shows, which is also the list the
 * arrow keys walk. Top-level pages open by default and deeper ones closed;
 * `toggled` holds the ones whose default has been flipped.
 */
function flatten(
  nodes: NotionPageNode[],
  depth: number,
  parent: string | undefined,
  toggled: ReadonlySet<string>,
  forceOpen: boolean,
  into: Row[] = [],
): Row[] {
  nodes.forEach((node, index) => {
    const open = forceOpen || (depth === 0) !== toggled.has(node.id);
    into.push({ node, depth, parent, open, pos: index + 1, size: nodes.length });
    if (open) flatten(node.children, depth + 1, node.id, toggled, forceOpen, into);
  });
  return into;
}

function Tree({
  nodes,
  selection,
  setSelection,
  forceOpen,
}: {
  nodes: NotionPageNode[];
  selection: ReadonlySet<string>;
  setSelection: (next: ReadonlySet<string>) => void;
  forceOpen: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const rows = useMemo(
    () => flatten(nodes, 0, undefined, toggled, forceOpen),
    [nodes, toggled, forceOpen],
  );
  // One row carries the tab stop; when a search hides the one that had it,
  // the first row takes over rather than nothing.
  const tabbable = rows.some((row) => row.node.id === focused) ? focused : rows[0]?.node.id;

  const flip = (id: string) => {
    const next = new Set(toggled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setToggled(next);
  };

  const focusRow = (index: number) => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
    items?.[index]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const row = rows[index];
    const branch = row.node.children.length > 0;
    switch (e.key) {
      case "ArrowDown":
        focusRow(Math.min(rows.length - 1, index + 1));
        break;
      case "ArrowUp":
        focusRow(Math.max(0, index - 1));
        break;
      case "ArrowRight":
        if (!branch) return;
        if (row.open) focusRow(index + 1);
        else flip(row.node.id);
        break;
      case "ArrowLeft":
        if (branch && row.open && !forceOpen) flip(row.node.id);
        else if (row.parent) focusRow(rows.findIndex((r) => r.node.id === row.parent));
        else return;
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      default:
        // Space and Enter are the button's own: they press it, and the press
        // is the tick.
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="nt-notion-tree">
      {rows.length === 0 && (
        <p role="status" className="nt-notion-nomatch">
          No page here is called that.
        </p>
      )}
      <div ref={ref} role="tree" aria-label="Pages to import" aria-multiselectable>
        {rows.map((row, index) => (
          <TreeRow
            key={row.node.id}
            row={row}
            selection={selection}
            setSelection={setSelection}
            tabbable={row.node.id === tabbable}
            onFocus={() => setFocused(row.node.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            onTwist={() => flip(row.node.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TreeRow({
  row,
  selection,
  setSelection,
  tabbable,
  onFocus,
  onKeyDown,
  onTwist,
}: {
  row: Row;
  selection: ReadonlySet<string>;
  setSelection: (next: ReadonlySet<string>) => void;
  tabbable: boolean;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onTwist: () => void;
}) {
  const { node, depth, open, pos, size } = row;
  const checked = selection.has(node.id);
  const descendants = useMemo(() => ids(node).slice(1), [node]);
  const someChildren = descendants.some((id) => selection.has(id));
  const state = checked ? "on" : someChildren ? "partial" : "off";

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
    <div className="nt-notion-row" style={{ paddingLeft: `${depth * 18}px` }}>
      {node.children.length ? (
        <button
          type="button"
          className="nt-notion-twist"
          aria-label={open ? "Collapse" : "Expand"}
          data-open={open || undefined}
          // Pointer affordance only; the arrow keys open and close from the row.
          tabIndex={-1}
          onClick={onTwist}
        >
          <ChevronRight />
        </button>
      ) : (
        <span className="nt-notion-twist-gap" />
      )}

      <button
        type="button"
        // Checked rather than selected: the row is a tick with three states,
        // and "some of what is under this is ticked" is one of them. ARIA 1.2
        // supports either on a treeitem and forbids both; the lint predates it.
        // eslint-disable-next-line jsx-a11y/role-has-required-aria-props
        role="treeitem"
        aria-checked={checked ? true : someChildren ? "mixed" : false}
        aria-level={depth + 1}
        aria-posinset={pos}
        aria-setsize={size}
        aria-expanded={node.children.length ? open : undefined}
        tabIndex={tabbable ? 0 : -1}
        className="nt-notion-pick"
        onClick={toggle}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        <span className="nt-notion-box" data-state={state}>
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

/**
 * The tree pruned to what matches, ancestors kept.
 *
 * A page whose own title does not match still appears when something under it
 * does — otherwise a search would hide the path to its own results.
 */
function matching(nodes: NotionPageNode[], query: string): NotionPageNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    const children = matching(node.children, query);
    const hit = node.title.toLowerCase().includes(needle);
    return hit || children.length ? [{ ...node, children }] : [];
  });
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

function ids(node: NotionPageNode): string[] {
  return [node.id, ...node.children.flatMap(ids)];
}

function returnHere(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search;
}
