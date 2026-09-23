"use client";

import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import type { Thread } from "@/app/lib/comments/types";
import { commentsScope } from "@/app/lib/history/undoRoute";
import { X } from "../Icons";
import { ThreadCard, type CardContext } from "./ThreadCard";

function scrollPane(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * Every thread on the page in one list, on a sheet at the page pane's right
 * edge: open threads, then those whose words are no longer in the document
 * (quoted, since there is nowhere to jump to), then resolved ones, newest
 * first. It is also where a thread opens when the margin cannot hold its card
 * — the dots of a narrow window, and the composer of a new thread there.
 *
 * Choosing an open thread whose words are in the page focuses it where it
 * lives; any other thread opens in place here.
 */
export function CommentsPanel({
  view,
  ctx,
  open,
  orphaned,
  resolved,
  expanded,
  focused,
  notices,
  draft,
  quote,
  onExpand,
  onOpen,
  onClose,
}: {
  view: EditorView;
  ctx: CardContext;
  open: readonly Thread[];
  orphaned: readonly Thread[];
  resolved: readonly Thread[];
  expanded: string | null;
  focused: string | null;
  notices: ReadonlyMap<string, string>;
  draft: ReactNode | null;
  quote: string | null;
  onExpand: (threadId: string) => void;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLElement>(null);

  // Laid over its own pane — in a split, the other page keeps its column.
  useLayoutEffect(() => {
    const el = sheet.current;
    const pane = scrollPane(view.dom);
    if (!el) return;
    const place = () => {
      const r = pane ? pane.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const width = Math.min(360, r.width - 16);
      el.style.top = `${r.top}px`;
      el.style.height = `${r.height}px`;
      el.style.width = `${width}px`;
      el.style.left = `${r.right - width}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    if (pane) observer.observe(pane);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [view]);

  // A row chosen here: open ones in the page go to their card or dot; the
  // rest open in place.
  const rowCtx = useMemo<CardContext>(
    () => ({
      ...ctx,
      choose: (threadId: string) => {
        if (open.some((t) => t.id === threadId)) onOpen(threadId);
        else onExpand(threadId);
      },
    }),
    [ctx, open, onOpen, onExpand],
  );

  const section = (title: string, threads: readonly Thread[], kind: "open" | "orphaned" | "resolved") =>
    threads.length > 0 && (
      <section className="nt-comments-section" data-section={kind} aria-label={title}>
        <h3 className="nt-section-label">
          {title} <span className="nt-comments-count">{threads.length}</span>
        </h3>
        <div className="nt-comments-rows">
          {threads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              focused={expanded === thread.id || (kind === "open" && focused === thread.id && expanded === null)}
              variant="panel"
              notice={notices.get(thread.id) ?? null}
              ctx={rowCtx}
            />
          ))}
        </div>
      </section>
    );

  const empty = !open.length && !orphaned.length && !resolved.length && !draft;

  return createPortal(
    <aside
      ref={sheet}
      className="nt-comments-panel"
      aria-label="Comments"
      tabIndex={-1}
      {...commentsScope(ctx.pageId)}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
    >
      <header className="nt-comments-head">
        <h2 className="nt-panel-title">Comments</h2>
        <button type="button" className="nt-icon-btn" aria-label="Close comments" title="Close comments" onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="nt-comments-body">
        {draft && (
          <div className="nt-comment-card is-panel is-draft" data-focused>
            {quote && <blockquote className="nt-comment-quote">{quote}</blockquote>}
            {draft}
          </div>
        )}
        {section("Open", open, "open")}
        {section("No longer in the document", orphaned, "orphaned")}
        {section("Resolved", resolved, "resolved")}
        {empty && (
          <p className="nt-comments-empty">
            {ctx.canComment ? "No comments yet. Select some words to start one." : "No comments yet."}
          </p>
        )}
      </div>
    </aside>,
    document.body,
  );
}
