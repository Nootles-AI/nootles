/**
 * The shapes a page arrives in, drawn before it does.
 *
 * A skeleton's whole job is to be wrong about nothing except the words. Every
 * measurement in here is the document's or the shell's own — a prose line is
 * `--text-body` at `--leading-body` carrying the editor's 3px block rhythm, a
 * tree row is `--control` tall with the same twist and glyph slots as a real
 * one — so when the content lands it lands ON the bars rather than shoving
 * them down the page. A skeleton that has to be re-laid-out is a flash, which
 * is the thing it was drawn to prevent.
 *
 * All of it is `aria-hidden`; the region that owns each one says `aria-busy`.
 *
 * No component here reads or waits for anything. That is what lets the whole
 * workspace shape be server-rendered into the first HTML — which is the point
 * of {@link WorkspaceSkeleton}, whose job is to fill the window before Clerk
 * has even loaded.
 */

import { Brandmark } from "./Brand";

/** The rails' resting widths — `Workspace`'s own, before localStorage speaks. */
const LEFT = 256;
const RIGHT = 320;

/** Milliseconds between one bar's shimmer and the next. */
const STAGGER = 90;

const delay = (i: number) =>
  ({ "--nt-skeleton-delay": `${i * STAGGER}ms` }) as React.CSSProperties;

/** One paragraph. Widths are percentages; the last line is always the short one. */
function Para({ lines, from }: { lines: readonly number[]; from: number }) {
  return (
    <div className="nt-doc-para">
      {lines.map((width, i) => (
        <div key={i} className="nt-doc-line">
          <span className="nt-skeleton" style={{ width: `${width}%`, ...delay(from + i) }} />
        </div>
      ))}
    </div>
  );
}

/**
 * The document body: two paragraphs of prose, which is enough to fill the
 * first screen of a page and to read as writing rather than as furniture.
 */
export function EditorSkeleton() {
  return (
    <div className="nt-doc-skeleton" aria-hidden="true">
      <Para lines={[100, 93, 62]} from={0} />
      <Para lines={[97, 100, 86, 38]} from={3} />
    </div>
  );
}

/**
 * A whole document column: the chrome row the mode toggle lands in, the title,
 * and the body. The wrapper repeats `PageSurface`'s own measurements rather
 * than importing them, because this is what stands in for that column before
 * it exists.
 */
export function PageSkeleton() {
  return (
    <main className="flex flex-1 flex-col overflow-hidden" aria-busy="true">
      <div
        className="w-full px-6 py-12 sm:px-14 sm:py-20"
        style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
      >
        <div className="nt-doc-chrome-row">
          <span className="nt-skeleton nt-doc-chrome" />
        </div>
        <div className="nt-doc-title">
          <span className="nt-skeleton" style={{ width: "44%" }} />
        </div>
        <EditorSkeleton />
      </div>
    </main>
  );
}

/**
 * The page tree, as `<li>`s inside the real `<ul role="tree">` — so the list
 * this stands in for keeps its own semantics and this adds none.
 *
 * It replaces what the sidebar used to say while the query was in flight,
 * which was "No pages yet — press + to add one." A project with forty pages
 * denied its own pages for a beat on every open.
 */
const TREE_ROWS = [58, 41, 67, 35, 52, 46];

export function TreeSkeleton() {
  return (
    <li role="none">
      <div className="space-y-px" aria-hidden="true">
        {TREE_ROWS.map((width, i) => (
          <div key={i} className="nt-row nt-tree-ghost">
            <span className="nt-row-twist" />
            <span className="nt-skeleton nt-tree-glyph" style={delay(i)} />
            <span
              className="nt-skeleton nt-tree-label"
              style={{ width: `${width}%`, ...delay(i) }}
            />
          </div>
        ))}
      </div>
    </li>
  );
}

/**
 * The shelf's cards. Exported because two different moments draw them: the
 * projects screen's own wait for its query, and — through
 * {@link ProjectsSkeleton} — the wait for a token before that.
 */
export function ProjectCardsSkeleton() {
  return (
    <ul className="nt-grid" aria-busy="true" aria-label="Loading projects">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i}>
          <div className="nt-card">
            <span
              className="nt-skeleton block aspect-[4/3] rounded-none"
              style={delay(i)}
            />
            <div className="nt-card-foot">
              <span className="nt-skeleton h-3.5 flex-1" style={{ maxWidth: "60%" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The front door, before the shelf arrives — `/`'s answer to the same blank
 * second `WorkspaceSkeleton` answers for a project.
 *
 * The mark and the word "Projects" are drawn for real rather than ghosted:
 * they are not waiting on anything, and a page that can say what it is should
 * say it. (`SharedProject`'s skeleton keeps its wordmark for the same reason.)
 * Grid rather than list because grid is what renders first either way — the
 * stored view is restored on mount, after this is gone.
 */
export function ProjectsSkeleton() {
  return (
    <main
      className="mx-auto w-full px-6 py-12 sm:px-8 sm:py-16"
      style={{ maxWidth: "76rem" }}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Brandmark
            role="img"
            aria-label="Nootles"
            width={20}
            height={24}
            className="text-brand"
          />
          <h1 className="text-[length:var(--text-title)] font-semibold tracking-[-0.02em]">
            Projects
          </h1>
        </div>
        <div className="flex items-center gap-2" aria-hidden="true">
          <span className="nt-skeleton nt-chrome-ghost" style={{ width: 60 }} />
          <span className="nt-skeleton nt-chrome-ghost" style={{ width: 112 }} />
          <span className="nt-skeleton nt-chrome-ghost" style={{ width: 28 }} />
        </div>
      </header>
      <div className="mt-8">
        <ProjectCardsSkeleton />
      </div>
    </main>
  );
}

/**
 * The whole workspace, before there is one.
 *
 * This is what `/p/[projectId]` shows while Clerk resolves a token, and it is
 * plain enough to be server-rendered — so the silhouette of the app is in the
 * first HTML the browser receives, and the window is never the blank white
 * sheet it used to be for the better part of a second.
 *
 * The rails are drawn at the widths `Workspace` itself renders first, so the
 * handover is a swap of contents rather than a change of layout.
 */
export function WorkspaceSkeleton() {
  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      aria-busy="true"
      aria-label="Loading project"
    >
      <aside className="nt-panel" style={{ width: LEFT }} aria-hidden="true">
        <div className="nt-panel-head">
          <span className="nt-skeleton nt-tree-label" style={{ width: "44%" }} />
        </div>
        <div className="px-2 pb-2">
          <div className="nt-row nt-tree-ghost">
            <span className="nt-skeleton nt-tree-label" style={{ width: "62%" }} />
          </div>
        </div>
        {/* The section label's own slot, so the tree below it starts where the
            real one will rather than sliding down at the handover. */}
        <div className="px-2">
          <div className="nt-section-label">
            <span className="nt-skeleton nt-tree-label" style={{ width: 44 }} />
          </div>
          <ul className="nt-pages space-y-px">
            <TreeSkeleton />
          </ul>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1">
        <PageSkeleton />
      </div>

      {/* No shapes in the chat rail: nothing predictable arrives there — an
          empty thread is a prompt, not a transcript — so the rail holds its
          width and says nothing rather than promising content. */}
      <aside className="nt-panel" style={{ width: RIGHT }} aria-hidden="true" />
    </div>
  );
}
