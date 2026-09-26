"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import {
  commentDraft,
  commentRanges,
  subscribeComments,
} from "@/app/components/editor/comments/commentDecorations";
import { CARD_GAP, stackCards, type Span } from "@/app/lib/comments/marginLayout";
import { ZOOM_EVENT } from "@/app/lib/docZoom";
import type { Thread } from "@/app/lib/comments/types";
import { commentsScope } from "@/app/lib/history/undoRoute";
import { ThreadCard, type CardContext, type Register } from "./ThreadCard";

/** The id the composer of a thread not yet written stands under in the layout. */
export const DRAFT = "\u0000draft";

/** Card width, and the room the margin must have to hold one beside the text. */
export const CARD_WIDTH = 264;
/**
 * From the text's right edge to a card's left: clear of the review's answer
 * buttons, which hang 10px off a changed block's edge and are ~54px wide.
 */
const GUTTER = 84;
/** Kept between a card and the pane's right edge. */
const EDGE = 16;
const DOT = 22;
const DOT_GAP = 4;

export type MarginMode = "cards" | "dots";

/** What one layout pass cost — read by the performance harness, never by the UI. */
export const marginStats = { passes: 0, lastMs: 0, totalMs: 0 };

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * The top of the text block holding `pos`, in viewport pixels: its first line
 * box, so a card's edge is level with the line rather than with the glyphs.
 */
function blockTop(view: EditorView, pos: number): number | null {
  try {
    const $pos = view.state.doc.resolve(pos);
    const start = $pos.start($pos.depth);
    const { node } = view.domAtPos(start);
    const el = node instanceof Element ? node : node.parentElement;
    return el ? el.getBoundingClientRect().top : view.coordsAtPos(start, 1).top;
  } catch {
    return null;
  }
}

/**
 * The page's open threads in its right margin, each card level with the top
 * of the block its words start in; or, where the margin is too narrow for a
 * card (a small window, the chat rail out, split view), a dot per thread in
 * the same place, which opens the thread in the panel.
 *
 * Cards portal to the body on a fixed layer clipped to the page's scroll
 * pane (the NT-52 overlay convention) and are positioned by transform, from
 * one layout pass: every position and height read first, `stackCards` over
 * them, then every write. A pass runs in the next frame after the highlights
 * move (one notification per transaction), the page or a card resizes, or
 * the cards change — never per thread, and never as a React render: typing
 * moves the cards without re-rendering one. Scrolling moves only the track
 * the cards ride on.
 */
export function CommentMargin({
  view,
  threads,
  draft,
  focused,
  mode,
  onMode,
  notices,
  ctx,
  onDot,
}: {
  view: EditorView;
  /** Open threads anchored in the page. */
  threads: readonly Thread[];
  /** The composer for a new thread, while one is open in the margin. */
  draft: ReactNode | null;
  focused: string | null;
  mode: MarginMode;
  onMode: (mode: MarginMode) => void;
  notices: ReadonlyMap<string, string>;
  ctx: CardContext;
  onDot: (threadId: string) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const pass = useRef<() => void>(() => {});
  const resize = useRef<ResizeObserver | null>(null);

  const order = threads.map((t) => t.id);
  const latest = useRef({ order, focused, mode, onMode, hasDraft: draft !== null });
  useLayoutEffect(() => {
    latest.current = { order, focused, mode, onMode, hasDraft: draft !== null };
  });

  useEffect(() => {
    const scroller = scrollParent(view.dom);
    let frame = 0;
    const settle: HTMLElement[] = [];
    // A draft whose words were edited away keeps its place: its box still has the keyboard.
    let draftTop: number | null = null;
    // Cards are placed against the text as it stood at the last pass; a zoomed
    // page also scrolls sideways, and the track carries that difference.
    let leftAtRun = 0;

    const run = () => {
      frame = 0;
      const layer = layerRef.current;
      const track = trackRef.current;
      if (!layer || !track || view.isDestroyed) return;
      const started = performance.now();
      const { order, focused, mode, onMode, hasDraft } = latest.current;
      if (!hasDraft) draftTop = null;

      // Reads.
      const pane = scroller
        ? scroller.getBoundingClientRect()
        : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const text = view.dom.getBoundingClientRect();
      const scrollTop = scroller ? scroller.scrollTop : 0;
      leftAtRun = scroller ? scroller.scrollLeft : 0;
      const room = pane.right - EDGE - (text.right + GUTTER);
      const want: MarginMode = room >= CARD_WIDTH ? "cards" : "dots";
      const ranges = commentRanges(view.state);
      const ids = hasDraft && want === "cards" ? [...order, DRAFT] : order;
      const draftRange = commentDraft(view.state);
      const wanted = ids.flatMap((id) => {
        const range = id === DRAFT ? draftRange : ranges.get(id);
        const el = items.current.get(id);
        const seen = range ? blockTop(view, range.from) : null;
        const top = seen !== null ? seen - pane.top + scrollTop : id === DRAFT ? draftTop : null;
        if (id === DRAFT) draftTop = top;
        if (!el || top === null) return [];
        return [{ id, top, height: mode === "cards" ? el.offsetHeight : DOT }];
      });
      const x = mode === "cards" ? text.right + GUTTER - pane.left : Math.min(text.right + 20, pane.right - DOT - 8) - pane.left;
      // A wide diagram reaches under the margin: nothing is stacked over one.
      const bands: Span[] = [];
      for (const band of view.dom.querySelectorAll(".nt-canvas[data-wide]")) {
        const r = band.getBoundingClientRect();
        if (r.height === 0 || r.right <= pane.left + x) continue;
        bands.push({ top: r.top - pane.top + scrollTop, bottom: r.bottom - pane.top + scrollTop });
      }
      const tops = stackCards(wanted, hasDraft ? DRAFT : focused, mode === "cards" ? CARD_GAP : DOT_GAP, bands);

      // Writes.
      layer.style.transform = `translate(${pane.left}px, ${pane.top}px)`;
      layer.style.width = `${pane.width}px`;
      layer.style.height = `${pane.height}px`;
      track.style.transform = `translate(0px, ${-scrollTop}px)`;
      for (const [id, el] of items.current) {
        const top = tops.get(id);
        el.hidden = top === undefined;
        if (top === undefined) continue;
        el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(top)}px, 0)`;
        if (!("settled" in el.dataset) && !settle.includes(el)) settle.push(el);
      }
      // A card's first placement is not a move; only later ones glide.
      if (settle.length) {
        requestAnimationFrame(() => {
          for (const el of settle.splice(0)) el.dataset.settled = "";
        });
      }
      if (want !== mode) onMode(want);

      const spent = performance.now() - started;
      marginStats.passes++;
      marginStats.lastMs = spent;
      marginStats.totalMs += spent;
    };

    const kick = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    // Scrolling the pane moves the track alone; nothing is measured again.
    const onScroll = () => {
      if (!scroller) return kick();
      if (trackRef.current) {
        trackRef.current.style.transform = `translate(${leftAtRun - scroller.scrollLeft}px, ${-scroller.scrollTop}px)`;
      }
    };
    pass.current = run;
    const observer = new ResizeObserver(kick);
    observer.observe(view.dom);
    if (scroller) observer.observe(scroller);
    for (const el of items.current.values()) observer.observe(el);
    resize.current = observer;
    const unsubscribe = subscribeComments(view, kick);
    window.addEventListener("resize", kick);
    (scroller ?? window).addEventListener("scroll", onScroll, { passive: true });
    // A zoom resizes nothing the observer watches: the pane keeps its box.
    scroller?.addEventListener(ZOOM_EVENT, kick);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
      resize.current = null;
      window.removeEventListener("resize", kick);
      (scroller ?? window).removeEventListener("scroll", onScroll);
      scroller?.removeEventListener(ZOOM_EVENT, kick);
      pass.current = () => {};
    };
  }, [view]);

  // A render changed what is in the margin: place it before it paints.
  useLayoutEffect(() => {
    pass.current();
  });

  const register = useCallback<Register>((id, el) => {
    items.current.set(id, el);
    resize.current?.observe(el);
    return () => {
      if (items.current.get(id) === el) items.current.delete(id);
      resize.current?.unobserve(el);
    };
  }, []);

  return createPortal(
    <div ref={layerRef} className="nt-comment-layer" data-mode={mode} {...commentsScope(ctx.pageId)} tabIndex={-1}>
      <div ref={trackRef} className="nt-comment-track">
        {mode === "cards"
          ? threads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                focused={focused === thread.id}
                variant="margin"
                notice={notices.get(thread.id) ?? null}
                ctx={ctx}
                register={register}
              />
            ))
          : threads.map((thread) => (
              <Dot key={thread.id} thread={thread} focused={focused === thread.id} register={register} onOpen={onDot} />
            ))}
        {mode === "cards" && draft && (
          <div
            ref={(el) => (el ? register(DRAFT, el) : undefined)}
            className="nt-comment-card is-margin is-draft"
            data-focused
            {...commentsScope(ctx.pageId)}
            tabIndex={-1}
          >
            {draft}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A thread where the margin has no room for its card: a count, in its place. */
const Dot = memo(function Dot({
  thread,
  focused,
  register,
  onOpen,
}: {
  thread: Thread;
  focused: boolean;
  register: Register;
  onOpen: (threadId: string) => void;
}) {
  const { id } = thread;
  const ref = useCallback((el: HTMLButtonElement | null) => (el ? register(id, el) : undefined), [register, id]);
  return (
    <button
      ref={ref}
      type="button"
      className="nt-comment-dot"
      data-thread-dot={id}
      data-focused={focused || undefined}
      aria-label={`Open the comment on “${thread.anchor.exact}”`}
      title={`${thread.comments.length} ${thread.comments.length === 1 ? "comment" : "comments"}`}
      onClick={() => onOpen(id)}
    >
      {thread.comments.length}
    </button>
  );
});
