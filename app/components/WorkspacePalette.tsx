"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import { homePath } from "@/app/lib/containerPaths";
import { paletteMatch } from "@/app/lib/paletteMatch";
import { Dialog } from "./Dialog";
import {
  ArrowLeft,
  ChevronRight,
  FileDoc,
  PanelLeft,
  PanelRight,
  PersonPlus,
  Search,
} from "./Icons";
import { useStandIn } from "./StandIn";
import { slugOf, useContainer } from "./workspaces/ContainerContext";
import { INVITE_WORDS, InvitePage } from "./workspaces/InvitePage";
import { offersInvite } from "./workspaces/seats";
import type { ModeCommand } from "./pageCommands";
import type { PageMode } from "./editor/ai/useTabCompletion";

/** A keyboard, in the app's 24-grid stroke. */
function Keyboard() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8" />
    </svg>
  );
}

/** A spark, for the suggestion mode's rows. */
function Spark() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
    </svg>
  );
}

/** Both lines describe what the model does, not what you happen to be doing. */
const MODES: { id: PageMode; name: string; line: string; words: readonly string[] }[] = [
  { id: "create", name: "Suggestions: Create", line: "Writes what is not there yet", words: ["mode", "ai", "create", "complete", "suggest"] },
  { id: "complete", name: "Suggestions: Complete", line: "Only finishes what you started", words: ["mode", "ai", "create", "complete", "suggest"] },
];

/**
 * ⌘K inside a project: the projects screen's palette, pointed at pages.
 *
 * It mostly goes places — a page, a rail, the project list. The one thing it
 * changes, the open page's suggestion mode, it asks the page to change: the
 * page writes it and records it on the undo spine. Making a page stays with the
 * sidebar, which already records it.
 */

type Row = {
  id: string;
  group: string;
  name: string;
  line?: string;
  icon: ReactNode;
  /** Other words the row is found by, beside its name. */
  words?: readonly string[];
  /** Opens a page of the palette rather than leaving it. */
  drill?: boolean;
  run: () => void;
};

export function WorkspacePalette({
  pages,
  currentPageId,
  leftOpen,
  rightOpen,
  canChat,
  mode,
  onOpenPage,
  onToggleLeft,
  onToggleRight,
  onShowKeys,
  onClose,
}: {
  pages: { _id: Id<"pages">; title: string }[];
  currentPageId: Id<"pages"> | null;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Viewers have no assistant, so they are not offered its rail. */
  canChat: boolean;
  /** The open page's suggestion mode, when it is one you can change. */
  mode?: ModeCommand | null;
  onOpenPage: (id: Id<"pages">) => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onShowKeys: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog label="Find a page" className="nt-palette is-solo nt-wpal" onClose={onClose}>
      {(close) => (
        <Body
          pages={pages}
          currentPageId={currentPageId}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          canChat={canChat}
          mode={mode}
          onOpenPage={onOpenPage}
          onToggleLeft={onToggleLeft}
          onToggleRight={onToggleRight}
          onShowKeys={onShowKeys}
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
  mode,
  onOpenPage,
  onToggleLeft,
  onToggleRight,
  onShowKeys,
  close,
}: Omit<Parameters<typeof WorkspacePalette>[0], "onClose"> & { close: () => void }) {
  const router = useRouter();
  // Home is the list this project is in: yours, or its workspace's.
  const container = useContainer();
  const home = homePath(slugOf(container));
  const homeName =
    container.kind === "workspace" ? `All projects in ${container.name}` : "All projects";
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // The one page past the list: inviting someone, for a workspace project's
  // owners and admins. A seat that stops being one finds itself back at the list.
  const standIn = useStandIn();
  const inviteTo =
    container.kind === "workspace" && offersInvite(container.role, standIn) ? container : null;
  const [asked, setPage] = useState<"root" | "invite">("root");
  const page = inviteTo ? asked : "root";
  const go = (to: "root" | "invite") => {
    setPage(to);
    setQuery("");
    setIndex(0);
  };

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
      ...(mode
        ? MODES.map((m) => ({
            id: `mode-${m.id}`,
            group: "This page",
            name: m.name,
            line: m.id === mode.mode ? "On" : m.line,
            icon: <Spark />,
            words: m.words,
            run: () => mode.set(m.id),
          }))
        : []),
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
        id: "keys",
        group: "Go",
        name: "Keyboard shortcuts",
        line: "?",
        icon: <Keyboard />,
        run: onShowKeys,
      },
      {
        id: "home",
        group: "Go",
        name: homeName,
        icon: <ArrowLeft width={16} height={16} />,
        run: () => router.push(home),
      },
      ...(inviteTo
        ? [
            {
              id: "invite",
              group: "People",
              name: `Invite people to ${inviteTo.name}`,
              icon: <PersonPlus />,
              words: INVITE_WORDS,
              drill: true,
              run: () => {
                setPage("invite");
                setQuery("");
                setIndex(0);
              },
            },
          ]
        : []),
    ];
    return all.filter((r) => paletteMatch(query, r.name, r.words));
  }, [pages, currentPageId, leftOpen, rightOpen, canChat, mode, query, onOpenPage, onToggleLeft, onToggleRight, onShowKeys, router, home, homeName, inviteTo]);

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
  }, [at, rows.length, page]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (!row.drill) close();
    row.run();
  };

  if (page === "invite" && inviteTo) {
    return (
      <div
        className="flex min-h-0 flex-col"
        onKeyDown={(e) => {
          // Escape backs out to the list before it closes the palette. The
          // dialog hears Escape on `document`, where React listens too, so
          // stopping propagation is not enough to keep it from closing.
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.nativeEvent.stopImmediatePropagation();
          go("root");
        }}
      >
        <div className="nt-pal-field">
          <button type="button" className="nt-pal-crumb" onClick={() => go("root")}>
            Invite people
          </button>
          <span className="flex-1" />
          <kbd className="nt-kbd">esc</kbd>
        </div>
        <InvitePage workspace={inviteTo} onBack={() => go("root")} />
      </div>
    );
  }

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
                {r.drill && <ChevronRight width={14} height={14} className="nt-pal-chev" />}
              </div>
            </div>
          ))}
          {rows.length === 0 && <p className="nt-pal-none">No page matches “{query}”.</p>}
        </div>
      </div>

      <div className="nt-pal-foot">
        <span>
          <kbd className="nt-kbd">↵</kbd>
          {current?.drill ? "Continue" : "Open"}
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
