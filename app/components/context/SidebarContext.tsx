"use client";

import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CONTEXT_FILE_ACCEPT } from "@/convex/files/shared";
import { ContextMenu } from "../ContextMenu";
import { Dialog } from "../Dialog";
import { FileDoc, Plus } from "../Icons";
import { NotionMark } from "../NotionMark";
import { MARKS, useProjectSources, type Card } from "./ContextSources";
import { GitHubMark } from "./marks";
import { GitHubSourcePage, NotionSourcePage } from "./SourcePages";
import "./sources.css";

type Door = "github" | "notion";
type Menu = { x: number; y: number } & ({ kind: "add" } | { kind: "row"; card: Card });

/**
 * The project's context at the foot of the sidebar: every source it reads, one
 * row each, drawn like a page — its mark and its name — so what the assistant
 * knows sits beside what the project is made of. A row opens the graph on
 * itself; + adds a file, a repository or Notion pages.
 */
export function SidebarContext({
  projectId,
  onOpen,
}: {
  projectId: Id<"projects">;
  /** Opens the graph on a source, or on the project when given nothing. */
  onOpen: (focus?: string) => void;
}) {
  const sources = useProjectSources(projectId);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [door, setDoor] = useState<Door | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const at = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // From a click, under the button; from a right-click, where it landed.
    return e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 };
  };
  const act = (fn: () => void) => () => {
    fn();
    setMenu(null);
  };

  return (
    <section className="nt-sbctx" aria-label="Context">
      <div className="nt-section-label">
        <button
          type="button"
          onClick={() => onOpen()}
          title="See everything the assistant knows about this project"
          className="nt-sbctx-title"
        >
          Context
        </button>
        <button
          type="button"
          onClick={(e) => setMenu({ kind: "add", ...at(e) })}
          aria-label="Add context"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "add"}
          title="Add a file, repository or Notion pages"
          className="nt-icon-btn"
        >
          <Plus />
        </button>
      </div>

      <ul className="nt-sbctx-list" aria-label="Context sources">
        {sources.loaded && !sources.cards.length && (
          <li className="px-2 py-1 text-[13px] text-muted">Nothing yet — press + to add some.</li>
        )}
        {sources.cards.map((card) => (
          <li key={card.key}>
            <button
              type="button"
              onClick={() => onOpen(card.focus)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: "row", card, ...at(e) });
              }}
              title={card.line ? `${card.title}\n${card.line}` : card.title}
              className={`nt-row w-full${card.state ? ` is-${card.state}` : ""}`}
            >
              <span className="nt-row-twist" />
              <span className="nt-row-icon nt-sbctx-mark" aria-hidden>
                {card.emoji ?? MARKS[card.source]}
              </span>
              <span className="nt-row-label">{card.title}</span>
              {card.state === "busy" && <span className="nt-sbctx-busy" aria-label="Reading" />}
              {card.state === "problem" && <span className="nt-sbctx-problem" aria-label="Could not be read" />}
            </button>
          </li>
        ))}
      </ul>
      {sources.failure && (
        <p role="alert" className="px-2 pb-1 text-[12.5px] leading-snug text-danger">
          {sources.failure}
        </p>
      )}

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
          if (chosen.length) sources.upload(chosen);
        }}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.kind === "add" ? "Add context" : "Context source"}
          onClose={() => setMenu(null)}
        >
          {menu.kind === "add" ? (
            <>
              <MenuItem
                onClick={() => {
                  input.current?.click();
                  setMenu(null);
                }}
                disabled={sources.uploading}
              >
                <FileDoc width={14} height={14} />
                Upload a file
              </MenuItem>
              <MenuItem onClick={act(() => setDoor("github"))}>
                <GitHubMark width={13} height={13} />
                GitHub repository
              </MenuItem>
              <MenuItem onClick={act(() => setDoor("notion"))}>
                <NotionMark width={14} height={14} />
                Notion pages
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem onClick={act(() => onOpen(menu.card.focus))}>Show in graph</MenuItem>
              {menu.card.onReread && <MenuItem onClick={act(menu.card.onReread)}>Read again</MenuItem>}
              {menu.card.onRemove && (
                <>
                  <div className="nt-menu-sep" />
                  <MenuItem danger onClick={act(menu.card.onRemove)}>
                    Remove from context
                  </MenuItem>
                </>
              )}
            </>
          )}
        </ContextMenu>
      )}

      {door && (
        <Dialog
          label={door === "github" ? "Add GitHub repositories" : "Add Notion pages"}
          className="nt-palette"
          onClose={() => setDoor(null)}
        >
          {(close) => (
            <SourceSheet
              door={door}
              sources={sources}
              onDone={close}
            />
          )}
        </Dialog>
      )}
    </section>
  );
}

/** A source's palette page, on its own: the same field and list, ending where it began. */
function SourceSheet({
  door,
  sources,
  onDone,
}: {
  door: Door;
  sources: ReturnType<typeof useProjectSources>;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const github = useQuery(api.github.account.status, door === "github" ? {} : "skip");
  const notion = useQuery(api.notion.account.status, door === "notion" ? {} : "skip");
  const status = door === "github" ? github : notion;
  // Searched once there is something to search, as in the palette: not over a connect screen.
  const connected = !!status?.account && !status.account.invalidAt;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="nt-pal-field">
        <span className="nt-pal-crumb">{door === "github" ? "GitHub" : "Notion"}</span>
        {connected ? <input
          autoFocus
          type="search"
          aria-label={door === "github" ? "Search repositories" : "Search Notion pages"}
          placeholder={door === "github" ? "Search your repositories, or type owner/name…" : "Search your Notion pages…"}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        /> : <span className="flex-1" />}
        <kbd className="nt-kbd">esc</kbd>
      </div>
      {door === "github" ? (
        <GitHubSourcePage
          chosen={sources.repos}
          search={query}
          onChoose={(repos) => {
            sources.chooseRepos(repos);
            onDone();
          }}
          onBack={onDone}
        />
      ) : (
        <NotionSourcePage
          chosen={sources.pages}
          search={query}
          onChoose={(pages) => {
            sources.choosePages(pages);
            onDone();
          }}
          onBack={onDone}
        />
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={`nt-menu-item nt-sbctx-item${danger ? " is-danger" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
