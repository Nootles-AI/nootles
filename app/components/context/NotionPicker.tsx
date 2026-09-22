"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { PageNode } from "@/convex/notion/pages";
import { NotionMark } from "../NotionMark";
import { matchingPages, NotionPageTree } from "../notion/NotionPageTree";
import { openConnectWindow } from "./connectWindow";
import { PickerReading } from "./PickerReading";

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
  if (!status) return <PickerReading label="Reading your Notion pages" />;
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
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());

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

  const shown = useMemo(() => matchingPages(tree ?? [], query), [tree, query]);
  const byId = useMemo(() => new Map(walk(tree ?? []).map((p) => [p.id, p])), [tree]);
  // Ticking a page takes the pages under it, as the import does; the ones
  // already in context are simply not added twice.
  const adding = [...selection].filter((id) => !linked.has(id) && byId.has(id));
  const already = [...selection].filter((id) => linked.has(id)).length;

  return (
    <div className="nt-picker">
      <div className="p-1.5">
        <input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Swallowed either way: inside the new-project form a stray Enter
            // would create the project.
            if (e.key === "Enter") e.preventDefault();
            if (e.key === "Escape") {
              e.preventDefault();
              onDone();
            }
          }}
          placeholder="Search pages"
          aria-label="Search Notion pages"
          className="nt-input"
        />
      </div>
      <div className="nt-picker-list">
        {!tree && !failure && (
          <PickerReading label="Reading your Notion pages" words="Fetching Notion pages…" />
        )}
        {tree && !tree.length && (
          <p className="nt-picker-empty">No pages are shared with Nootles yet.</p>
        )}
        {tree && tree.length > 0 && (
          <NotionPageTree
            nodes={shown}
            selection={selection}
            setSelection={setSelection}
            forceOpen={!!query}
            label="Notion pages to read into context"
          />
        )}
      </div>
      {failure && (
        <p role="alert" className="nt-picker-foot text-danger">
          {failure}
        </p>
      )}
      <div className="nt-picker-foot">
        <span className="min-w-0 flex-1 truncate">
          {already ? `${already} already in context · ` : ""}
          <button
            type="button"
            onClick={() => openConnectWindow("/api/notion/connect")}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Share more pages
          </button>
        </span>
        <button
          type="button"
          disabled={!adding.length}
          onClick={() => {
            onAdd(
              adding.map((id) => {
                const page = byId.get(id)!;
                return {
                  pageId: page.id,
                  title: page.title || "Untitled",
                  ...(page.emoji ? { emoji: page.emoji } : {}),
                };
              }),
            );
            onDone();
          }}
          className="nt-row nt-solid px-3 font-medium"
        >
          {adding.length > 1 ? `Add ${adding.length} pages` : "Add page"}
        </button>
      </div>
    </div>
  );
}

function walk(nodes: PageNode[]): PageNode[] {
  return nodes.flatMap((page) => [page, ...walk(page.children)]);
}
