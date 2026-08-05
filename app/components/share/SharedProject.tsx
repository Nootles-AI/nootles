"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Wordmark } from "../Brand";
import { ReadOnlyContext } from "../editor/readOnly";
import { SharedEditor } from "./SharedEditor";

/**
 * The read-only face of one project, reached by share token. It borrows the
 * workspace's own vocabulary — the same rail, rows and page column — minus
 * everything that authors: no chat, no review, no plus buttons, no rename.
 */
export function SharedProject({ token }: { token: string }) {
  const shared = useQuery(api.share.view, { token });
  const [selected, setSelected] = useState<string | null>(null);

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
  const current = pages.find((p) => p.docId === selected) ?? pages[0] ?? null;

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden">
      <header
        className="flex h-12 shrink-0 items-center gap-3 px-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <Link href="/" aria-label="Nootles" className="shrink-0">
          <Wordmark />
        </Link>
        <span className="min-w-0 truncate text-sm font-medium">
          {shared.title || "Untitled project"}
        </span>
        <span className="ml-auto shrink-0 text-[13px] text-muted">
          Read-only
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {pages.length > 1 && (
          <aside className="nt-panel nt-rail-l" style={{ width: 256 }} aria-label="Pages">
            <nav className="flex-1 overflow-y-auto px-2 py-2">
              <div className="nt-section-label">
                <span>Pages</span>
              </div>
              <ul className="space-y-px">
                {pages.map((pg) => (
                  <li key={pg.docId}>
                    <button
                      onClick={() => setSelected(pg.docId)}
                      aria-current={
                        current?.docId === pg.docId ? "page" : undefined
                      }
                      className={`nt-row w-full${
                        current?.docId === pg.docId ? " is-selected" : ""
                      }`}
                    >
                      <span className="nt-row-label">
                        {pg.title || "Untitled"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col overflow-auto">
          {current ? (
            <div
              className="w-full px-6 py-12 sm:px-14 sm:py-20"
              style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
            >
              <h1 className="w-full text-[length:var(--text-title)] font-semibold tracking-[-0.02em] text-balance">
                {current.title || "Untitled"}
              </h1>
              <div className="mt-8">
                <ReadOnlyContext value={true}>
                  <SharedEditor key={current.docId} docId={current.docId} />
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
    </div>
  );
}
