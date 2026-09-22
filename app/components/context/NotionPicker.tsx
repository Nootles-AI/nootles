"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { PageNode } from "@/convex/notion/pages";
import { NotionMark } from "../NotionMark";
import { openConnectWindow } from "./connectWindow";

export type NotionChoice = { pageId: string; title: string; emoji?: string };

/**
 * Choosing Notion pages to read into a project's context — the Notion door of
 * the context sources. The pages stay in Notion; what is chosen here is read,
 * not imported. What the list holds is exactly what the connection was granted
 * on Notion's own consent screen, so a page missing from it is one to grant
 * there, and the way back is offered rather than an apology.
 */
export function NotionPicker({
  linked,
  onAdd,
  onDone,
}: {
  linked: ReadonlySet<string>;
  onAdd: (pages: NotionChoice[]) => void;
  onDone: () => void;
}) {
  const status = useQuery(api.notion.account.status);
  if (!status) return null;
  if (!status.ready) return <p className="nt-note">{status.blocker}</p>;
  if (!status.account) {
    return (
      <div className="nt-picker p-2.5">
        <button
          type="button"
          onClick={() => openConnectWindow("/api/notion/connect")}
          className="nt-row nt-solid w-full justify-center gap-2 px-3 font-medium"
        >
          <NotionMark width={14} height={14} />
          Connect Notion
        </button>
        <p className="nt-note mt-2">
          Choose the pages Nootles may read on Notion’s screen. They stay in Notion.
        </p>
      </div>
    );
  }
  return <Pages linked={linked} onAdd={onAdd} onDone={onDone} />;
}

function Pages({
  linked,
  onAdd,
  onDone,
}: {
  linked: ReadonlySet<string>;
  onAdd: (pages: NotionChoice[]) => void;
  onDone: () => void;
}) {
  const listPages = useAction(api.notion.pages.listPages);
  const [tree, setTree] = useState<PageNode[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<Map<string, NotionChoice>>(new Map());

  // Asked once per opening: a call outside React, made when the door opens.
  useEffect(() => {
    let alive = true;
    listPages({})
      .then((pages) => alive && setTree(pages))
      .catch((error) => alive && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      alive = false;
    };
  }, [listPages]);

  const rows = useMemo(() => flatten(tree ?? []), [tree]);
  const typed = filter.trim().toLowerCase();
  const shown = rows.filter((r) => !linked.has(r.page.id) && r.page.title.toLowerCase().includes(typed));

  const toggle = (page: PageNode) =>
    setChosen((prev) => {
      const next = new Map(prev);
      if (next.has(page.id)) next.delete(page.id);
      else next.set(page.id, { pageId: page.id, title: page.title || "Untitled", ...(page.emoji ? { emoji: page.emoji } : {}) });
      return next;
    });

  return (
    <div className="nt-picker">
      <div className="p-1.5">
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            // Swallowed either way: inside the new-project form a stray Enter
            // would create the project.
            if (e.key === "Enter") e.preventDefault();
            if (e.key === "Escape") {
              e.preventDefault();
              onDone();
            }
          }}
          placeholder="Filter pages"
          aria-label="Find a Notion page"
          className="nt-input"
        />
      </div>
      <div className="nt-picker-list">
        {!tree && !failure && <p className="nt-picker-empty">Reading your Notion pages…</p>}
        {tree && !shown.length && (
          <p className="nt-picker-empty">
            {typed ? "Nothing matches." : "No pages are shared with Nootles yet."}
          </p>
        )}
        {shown.map(({ page, depth }) => (
          <label key={page.id} className="nt-row w-full" style={{ paddingLeft: 8 + depth * 14 }}>
            <input
              type="checkbox"
              checked={chosen.has(page.id)}
              onChange={() => toggle(page)}
              className="nt-check"
            />
            <span aria-hidden className="w-4 shrink-0 text-center">
              {page.emoji ?? ""}
            </span>
            <span className="nt-row-label">{page.title || "Untitled"}</span>
          </label>
        ))}
      </div>
      {failure && (
        <p role="alert" className="nt-picker-foot text-danger">
          {failure}
        </p>
      )}
      <div className="nt-picker-foot">
        <button
          type="button"
          onClick={() => openConnectWindow("/api/notion/connect")}
          className="min-w-0 flex-1 truncate text-left underline underline-offset-2 hover:text-foreground"
        >
          Share more pages
        </button>
        <button
          type="button"
          disabled={!chosen.size}
          onClick={() => {
            onAdd([...chosen.values()]);
            onDone();
          }}
          className="nt-row nt-solid px-3 font-medium"
        >
          {chosen.size > 1 ? `Add ${chosen.size} pages` : "Add page"}
        </button>
      </div>
    </div>
  );
}

function flatten(nodes: PageNode[], depth = 0): { page: PageNode; depth: number }[] {
  return nodes.flatMap((page) => [{ page, depth }, ...flatten(page.children, depth + 1)]);
}
