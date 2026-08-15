"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { Wordmark } from "../Brand";
import { ArrowLeft, PanelLeft } from "../Icons";
import { CurrentPageProvider, useOpenPage } from "../OpenPageContext";
import { PagesProvider } from "../PagesContext";
import { ReadOnlyContext } from "../editor/readOnly";
import { SharedEditor } from "./SharedEditor";

/* The same threshold as the workspace: below it the rail becomes a drawer. */
const COMPACT = "(max-width: 1023px)";

/**
 * The read-only face of one project, reached by share token. It borrows the
 * workspace's own vocabulary — the same rail, rows, page column and page
 * selection — minus everything that authors: no chat, no review, no plus
 * buttons, no rename. Mention chips work because the same contexts they read
 * in the workspace (the page list, the open-page selection) are provided here.
 */
export function SharedProject({ token }: { token: string }) {
  const shared = useQuery(api.share.view, { token });
  // One column here, so the workspace's second pane never comes into it.
  const { main, open, back } = useOpenPage();
  const compact = useMediaQuery(COMPACT);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  if (shared === undefined) {
    // Mirrors the page column so the eventual content lands in place.
    return (
      <div className="flex h-screen w-full items-start" aria-busy="true">
        <div
          className="w-full px-6 py-12 sm:px-14 sm:py-20"
          style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
        >
          <div className="nt-skeleton h-8 w-1/2" />
          <div className="mt-8 space-y-3">
            <div className="nt-skeleton h-4 w-full" />
            <div className="nt-skeleton h-4 w-11/12" />
            <div className="nt-skeleton h-4 w-2/3" />
          </div>
        </div>
      </div>
    );
  }

  if (shared === null) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <Wordmark className="mb-4 text-muted" aria-label="Nootles" />
        <p className="text-sm font-medium">This project isn&apos;t shared</p>
        <p className="max-w-xs text-sm text-muted">
          The link may have been turned off. Ask whoever sent it to share the
          project again.
        </p>
      </div>
    );
  }

  const pages = shared.pages;
  // Resolved the way the workspace resolves it: a stale or foreign id falls
  // back to the first page rather than blanking the surface.
  const current = pages.find((p) => p._id === main.page) ?? pages[0] ?? null;

  const rail = (
    <aside
      className="nt-panel nt-rail-l"
      style={{ width: compact ? 288 : 256 }}
      aria-label="Pages"
    >
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <div className="nt-section-label">
          <span>Pages</span>
        </div>
        <ul className="space-y-px">
          {pages.map((pg) => (
            <li key={pg.docId}>
              <button
                onClick={() => {
                  open(pg._id);
                  setDrawer(false);
                }}
                aria-current={current?._id === pg._id ? "page" : undefined}
                className={`nt-row w-full${
                  current?._id === pg._id ? " is-selected" : ""
                }`}
              >
                <span className="nt-row-label">{pg.title || "Untitled"}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );

  return (
    <PagesProvider pages={pages}>
    <div className="flex h-screen w-full flex-col overflow-hidden">
      <header
        className="relative flex h-12 shrink-0 items-center gap-2 px-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {compact && (
          <button
            onClick={() => setDrawer(true)}
            aria-label="Open pages"
            title="Pages"
            className="nt-icon-btn"
          >
            <PanelLeft />
          </button>
        )}
        <Link href="/" aria-label="Nootles" className="shrink-0">
          <Wordmark />
        </Link>
        {/* Centred on the bar itself, not on what the wordmark leaves over. */}
        <span className="absolute left-1/2 top-1/2 max-w-[40%] -translate-x-1/2 -translate-y-1/2 truncate text-sm font-medium">
          {shared.title || "Untitled project"}
        </span>
        <span className="ml-auto shrink-0 text-[13px] text-muted">
          Read-only
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {!compact && rail}

        <main className="flex min-w-0 flex-1 flex-col overflow-auto">
          {current ? (
            <div
              className="w-full px-6 py-12 sm:px-14 sm:py-20"
              style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
            >
              {/* Following a chip somewhere needs a way home — same rule as
                  the workspace: present only once there is a back to mean. */}
              {main.canGoBack && (
                <div className="mb-6 flex justify-start">
                  <button
                    onClick={() => back("main")}
                    aria-label="Back to previous page"
                    title="Back to previous page"
                    className="nt-icon-btn"
                  >
                    <ArrowLeft />
                  </button>
                </div>
              )}
              <h1 className="w-full text-[length:var(--text-title)] font-semibold tracking-[-0.02em] text-balance">
                {current.title || "Untitled"}
              </h1>
              <div className="mt-8">
                <ReadOnlyContext value={true}>
                  <CurrentPageProvider pageId={current._id}>
                    <SharedEditor key={current.docId} docId={current.docId} />
                  </CurrentPageProvider>
                </ReadOnlyContext>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted">
              This project has no pages.
            </div>
          )}
        </main>
      </div>

      {compact && drawer && (
        <>
          <button
            aria-label="Close pages"
            onClick={() => setDrawer(false)}
            className="fixed inset-0 bg-foreground/15"
            style={{ zIndex: "var(--z-overlay)" }}
          />
          <div
            className="fixed inset-y-0 left-0 shadow-2xl"
            style={{ zIndex: "var(--z-modal)" }}
          >
            {rail}
          </div>
        </>
      )}
    </div>
    </PagesProvider>
  );
}
