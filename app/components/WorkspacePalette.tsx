"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog } from "./Dialog";
import { ArrowLeft, FileDoc, PanelLeft, PanelRight, Search } from "./Icons";

/**
 * ⌘K inside a project: the projects screen's palette, pointed at pages.
 *
 * It only goes places — a page, a rail, the project list. Nothing here writes,
 * so nothing here has to answer to the undo spine; making a page stays with the
 * sidebar, which already records it.
 */

type Row = { id: string; group: string; name: string; line?: string; icon: ReactNode; run: () => void };

export function WorkspacePalette({
  pages,
  currentPageId,
  leftOpen,
  rightOpen,
  canChat,
  onOpenPage,
  onToggleLeft,
  onToggleRight,
  onClose,
}: {
  pages: { _id: Id<"pages">; title: string }[];
  currentPageId: Id<"pages"> | null;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Viewers have no assistant, so they are not offered its rail. */
  canChat: boolean;
  onOpenPage: (id: Id<"pages">) => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog label="Find a page" className="nt-palette is-solo" onClose={onClose}>
      {(close) => (
        <Body
          pages={pages}
          currentPageId={currentPageId}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          canChat={canChat}
          onOpenPage={onOpenPage}
          onToggleLeft={onToggleLeft}
          onToggleRight={onToggleRight}
          close={close}
        />
      )}
    </Dialog>
  );
}

function Body({
  pages,
  currentPageId,
  leftOpen,
  rightOpen,
  canChat,
  onOpenPage,
  onToggleLeft,
  onToggleRight,
  close,
}: Omit<Parameters<typeof WorkspacePalette>[0], "onClose"> & { close: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const all: Row[] = [
      ...pages.map((p) => ({
        id: p._id as string,
        group: "Pages",
        name: p.title || "Untitled",
        line: p._id === currentPageId ? "Open now" : undefined,
        icon: <FileDoc width={16} height={16} />,
        run: () => onOpenPage(p._id),
      })),
      {
        id: "left",
        group: "Go",
        name: leftOpen ? "Hide sidebar" : "Show sidebar",
        icon: <PanelLeft />,
        run: onToggleLeft,
      },
      ...(canChat
        ? [
            {
              id: "right",
              group: "Go",
              name: rightOpen ? "Hide chat" : "Show chat",
              icon: <PanelRight />,
              run: onToggleRight,
            },
          ]
        : []),
      {
        id: "home",
        group: "Go",
        name: "All projects",
        icon: <ArrowLeft width={16} height={16} />,
        run: () => router.push("/"),
      },
    ];
    const q = query.trim().toLowerCase();
    return q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  }, [pages, currentPageId, leftOpen, rightOpen, canChat, query, onOpenPage, onToggleLeft, onToggleRight, router]);

  const at = Math.min(index, Math.max(rows.length - 1, 0));
  const current = rows.at(at);

  // One highlight that travels, placed from the selected row's measured box.
  useEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !row) return;
    box.style.setProperty("--hl-y", `${row.offsetTop}px`);
    box.style.setProperty("--hl-h", `${row.offsetHeight}px`);
    row.scrollIntoView({ block: "nearest" });
  }, [at, rows.length]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    close();
    row.run();
  };

  return (
    <div
      className="flex min-h-0 flex-col"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" && rows.length) {
          e.preventDefault();
          setIndex((at + 1) % rows.length);
        } else if (e.key === "ArrowUp" && rows.length) {
          e.preventDefault();
          setIndex((at - 1 + rows.length) % rows.length);
        } else if (e.key === "Enter") {
          e.preventDefault();
          choose(current);
        }
      }}
    >
      <div className="nt-pal-field">
        <Search width={16} height={16} className="shrink-0 text-muted" aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="nt-wpal-list"
          aria-activedescendant={current ? `nt-wpal-${current.id}` : undefined}
          aria-label="Find a page"
          placeholder="Open a page…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
        />
        <kbd className="nt-kbd">esc</kbd>
      </div>

      <div className="nt-pal-panes">
        <div ref={list} id="nt-wpal-list" role="listbox" aria-label="Pages" className="nt-pal-list">
          <span className="nt-pal-hl" aria-hidden="true" data-none={rows.length === 0} />
          {rows.map((r, i) => (
            <div key={r.id}>
              {r.group !== rows[i - 1]?.group && <div className="nt-pal-group">{r.group}</div>}
              <div
                id={`nt-wpal-${r.id}`}
                role="option"
                aria-selected={i === at}
                className="nt-pal-row"
                // The field keeps focus through a click, so the arrows still land.
                onMouseDown={(e) => e.preventDefault()}
                onPointerMove={() => {
                  if (i !== at) setIndex(i);
                }}
                onClick={() => choose(r)}
              >
                <span className="nt-pal-icon">{r.icon}</span>
                <span className="nt-pal-text">
                  <span className="nt-pal-name">{r.name}</span>
                  {r.line && <span className="nt-pal-line">{r.line}</span>}
                </span>
              </div>
            </div>
          ))}
          {rows.length === 0 && <p className="nt-pal-none">No page matches “{query}”.</p>}
        </div>
      </div>

      <div className="nt-pal-foot">
        <span>
          <kbd className="nt-kbd">↵</kbd>
          Open
        </span>
        <span>
          <kbd className="nt-kbd">↑</kbd>
          <kbd className="nt-kbd">↓</kbd>
          Move
        </span>
      </div>
    </div>
  );
}
