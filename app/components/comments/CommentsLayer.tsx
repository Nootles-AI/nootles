"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { api } from "@/convex/_generated/api";
import {
  commentDraft,
  commentRanges,
  setActiveThread,
  setCommentDraft,
} from "@/app/components/editor/comments/commentDecorations";
import type { MentionPick } from "@/app/lib/ai/chat/mentions";
import { initials, outsiderNote, type Person } from "@/app/lib/comments/compose";
import { PAGE_PARAM, THREAD_PARAM } from "@/app/lib/comments/link";
import { anchorForSelection } from "@/app/lib/comments/pmText";
import { signers, type Thread } from "@/app/lib/comments/types";
import { useReadOnly } from "../editor/readOnly";
import { CommentComposer } from "./CommentComposer";
import { CommentMargin, type MarginMode } from "./CommentMargin";
import { CommentsPanel } from "./CommentsPanel";
import { CommentsUIContext, type CommentsUI } from "./commentsUI";
import { useActiveThread, useAnchoredThreads, useCommentsEditorView } from "./commentsView";
import { usePageComments } from "./PageComments";
import { SelectionAffordance } from "./SelectionAffordance";
import type { CardContext } from "./ThreadCard";
import { useCommentableSelection, type SelectedWords } from "./useCommentableSelection";
import { useThreadActions } from "./useThreadActions";
import "./comments.css";

const NO_PEOPLE: Person[] = [];
const NO_NOTICES: ReadonlyMap<string, string> = new Map();

/** ⌘⌥M / Ctrl+Alt+M. By key code: ⌥M types "µ" on a Mac. */
function isCommentKey(e: KeyboardEvent): boolean {
  return e.code === "KeyM" && (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey;
}

/** A clock for comment ages, ticking slowly enough to be no cost. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Scroll a thread's highlight into view if it is not already. */
function reveal(view: EditorView, threadId: string) {
  const mark = view.dom.querySelector<HTMLElement>(`[data-thread="${CSS.escape(threadId)}"]`);
  if (!mark) return;
  const r = mark.getBoundingClientRect();
  if (r.top >= 80 && r.bottom <= window.innerHeight - 80) return;
  mark.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
}

/**
 * One page's comment UI (docs/commenting-plan.md §7), around its editor: the
 * margin's cards (or dots), the composer for a new thread, the panel, the
 * floating Comment button of a read-only page, ⌘⌥M, and opening a thread a
 * link names (`?thread=`).
 *
 * Which thread is focused is the highlights' answer (`activeThread`): the
 * caret's thread in an editable page, the clicked one in a read-only page, or
 * whichever a card, dot or panel row last chose — so the margin, the
 * highlights and the panel can never disagree about it.
 *
 * `linked` is the pane a link's page opens in; it is the one that drops a
 * `?thread=` naming a thread no longer there.
 */
export function CommentsLayer({ linked, children }: { linked: boolean; children: ReactNode }) {
  const comments = usePageComments();
  const readOnly = useReadOnly();
  const view = useCommentsEditorView();
  const active = useActiveThread(view);
  const anchored = useAnchoredThreads(view);
  const selection = useCommentableSelection();
  const actions = useThreadActions(comments);
  const now = useNow();
  const markPageSeen = useMutation(api.commentNotices.markPageSeen);

  const pageId = comments?.pageId ?? null;
  const userId = comments?.userId ?? null;
  const canRead = Boolean(comments?.access.canRead);
  const canComment = Boolean(comments?.access.canComment && userId);
  const threads = comments?.threads;
  const named = useMemo(() => signers(threads ?? [], userId), [threads, userId]);
  const authors =
    useQuery(api.commentNotices.authors, pageId && canRead && userId ? { pageId, userIds: named } : "skip") ?? NO_PEOPLE;
  const mentionable = useQuery(api.commentNotices.mentionable, pageId && canComment ? { pageId } : "skip") ?? NO_PEOPLE;

  const [draft, setDraft] = useState<SelectedWords | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; expanded: string | null }>({ open: false, expanded: null });
  const [mode, setMode] = useState<MarginMode>("cards");
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(NO_NOTICES);
  /** A thread just written, to focus once the highlights have found its words. */
  const pendingFocus = useRef<string | null>(null);
  // The surface outlives a page change; what was open belonged to the last page.
  const [shown, setShown] = useState(pageId);
  if (shown !== pageId) {
    setShown(pageId);
    setDraft(null);
    setPanel({ open: false, expanded: null });
    setNotices(NO_NOTICES);
  }

  const { margin, orphaned, resolved } = useMemo(() => {
    const all = threads ?? [];
    const open = all.filter((t) => t.status === "open");
    const placed = (t: Thread) => (view ? anchored.has(t.id) : t.orphanedAt === undefined);
    const ranges = view ? commentRanges(view.state) : null;
    const at = (t: Thread) => ranges?.get(t.id)?.from ?? 0;
    return {
      margin: open.filter(placed).sort((a, b) => at(a) - at(b)),
      orphaned: open.filter((t) => !placed(t)),
      resolved: all
        .filter((t) => t.status === "resolved")
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
    };
  }, [threads, anchored, view]);
  const focused = margin.some((t) => t.id === active) ? active : null;

  const note = useCallback((threadId: string, text: string | null) => {
    setNotices((held) => {
      if ((held.get(threadId) ?? null) === text) return held;
      const next = new Map(held);
      if (text === null) next.delete(threadId);
      else next.set(threadId, text);
      return next;
    });
  }, []);

  /** Make a thread the focused one, as its card, dot or row was clicked. */
  const choose = useCallback(
    (threadId: string) => {
    setNotices((held) => {
      if (!held.size || (held.size === 1 && held.has(threadId))) return held;
      const kept = held.get(threadId);
      return kept ? new Map([[threadId, kept]]) : NO_NOTICES;
    });
    if (!view) return;
    setActiveThread(view, threadId);
    reveal(view, threadId);
    },
    [view],
  );

  /**
   * Open a thread from outside its card — a dot, a panel row, a link. One in
   * the margin is focused there; one the margin cannot show (resolved, no
   * longer in the page, or a margin too narrow for cards) opens in the panel.
   */
  const openThread = useCallback(
    (threadId: string) => {
      const thread = threads?.find((t) => t.id === threadId);
      if (!thread) return;
      const inPage = thread.status === "open" && view !== null && commentRanges(view.state).get(threadId);
      if (inPage) choose(threadId);
      if (inPage && mode === "cards") {
        setPanel((p) => ({ ...p, open: false }));
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`.nt-comment-layer [data-thread-card="${CSS.escape(threadId)}"]`)
            ?.focus({ preventScroll: true }),
        );
      } else {
        setPanel({ open: true, expanded: threadId });
      }
    },
    [threads, mode, view, choose],
  );

  const cancelDraft = useCallback(() => setDraft(null), []);

  // The highlight shows the open draft's words, and goes when it closes.
  useEffect(() => {
    if (view && !draft) setCommentDraft(view, null);
  }, [view, draft]);

  const start = useCallback(
    (words: SelectedWords) => {
      setDraft(words);
      setNotices(NO_NOTICES);
      if (view) {
        setCommentDraft(view, { from: words.from, to: words.to });
        // The page's own selection lets go, so the formatting toolbar over it
        // does too; the draft highlight shows the words instead.
        if (view.editable) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, words.to)));
      }
      if (mode === "dots") setPanel({ open: true, expanded: null });
    },
    [view, mode],
  );

  /**
   * Focus a thread just written — card and highlight — as soon as the
   * highlights have found its words: at once if they already have, else when
   * they do.
   */
  const focusWritten = useCallback(
    (threadId: string) => {
      if (!view || !commentRanges(view.state).get(threadId)) {
        pendingFocus.current = threadId;
        return;
      }
      pendingFocus.current = null;
      setActiveThread(view, threadId);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-thread-card="${CSS.escape(threadId)}"]`)
          ?.focus({ preventScroll: true }),
      );
    },
    [view],
  );

  const submitDraft = useCallback(
    async (body: string, mentions: string[], picks: MentionPick[]) => {
      if (!draft) return;
      // The words may have been edited while the comment was written: anchor
      // to what the draft's live range covers now, and refuse if nothing does.
      const live = view ? commentDraft(view.state) : { from: draft.from, to: draft.to };
      const anchor = live && view ? anchorForSelection(view.state.doc, live.from, live.to) : live && draft.anchor;
      if (!anchor) throw new Error("The words this comment was about are no longer in the page.");
      const { threadId, outsiders } = await actions.create({ anchor, body, mentions });
      // Only the draft that was posted closes: another may have opened meanwhile.
      setDraft((current) => (current === draft ? null : current));
      if (outsiders.length) note(threadId, outsiderNote(outsiders, picks, true));
      if (mode === "dots") setPanel({ open: true, expanded: threadId });
      focusWritten(threadId);
    },
    [draft, view, actions, note, mode, focusWritten],
  );

  useEffect(() => {
    const threadId = pendingFocus.current;
    if (threadId && anchored.has(threadId)) focusWritten(threadId);
  }, [anchored, focusWritten]);

  // ⌘⌥M: comment on the selection, as the toolbar's button does.
  const latestSelection = useRef(selection);
  const startRef = useRef(start);
  useEffect(() => {
    latestSelection.current = selection;
    startRef.current = start;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isCommentKey(e)) return;
      const words = latestSelection.current;
      if (!words) return;
      e.preventDefault();
      e.stopPropagation();
      if (words.kind === "signIn") words.signIn();
      else startRef.current(words);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // A link to a thread — a comment notice's — opens it once the page's
  // threads are known, then gives the params up. A link that names its page
  // is that page's pane's to answer, wherever it opens (main or aside): any
  // other pane on screen would otherwise drop a thread it simply doesn't have.
  const params = useSearchParams();
  const requested = params?.get(THREAD_PARAM) ?? null;
  const bound = params?.get(PAGE_PARAM) ?? null;
  const status = comments?.status;
  const openRef = useRef(openThread);
  useEffect(() => {
    openRef.current = openThread;
  });
  useEffect(() => {
    if (!requested || !pageId || (bound && bound !== pageId)) return;
    const ready = status === "absent" || (status === "ready" && view !== null);
    if (!ready) return;
    const owns = (threads ?? []).some((t) => t.id === requested);
    if (!owns && !bound && !linked) return;
    if (owns) {
      openRef.current(requested);
      if (userId) void markPageSeen({ pageId }).catch(() => {});
    }
    const url = new URL(window.location.href);
    url.searchParams.delete(THREAD_PARAM);
    url.searchParams.delete(PAGE_PARAM);
    window.history.replaceState(null, "", url);
  }, [requested, bound, pageId, status, view, threads, linked, userId, markPageSeen]);

  const ctx = useMemo<CardContext | null>(
    () =>
      pageId
        ? {
            pageId,
            me: userId,
            authors,
            mentionable,
            canComment,
            canModerate: canComment && !readOnly,
            now,
            actions,
            choose,
            note,
          }
        : null,
    [pageId, userId, authors, mentionable, canComment, readOnly, now, actions, choose, note],
  );

  const expand = useCallback((threadId: string) => setPanel({ open: true, expanded: threadId }), []);
  const closePanel = useCallback(() => {
    setPanel({ open: false, expanded: null });
    if (mode === "dots") cancelDraft();
  }, [mode, cancelDraft]);
  const togglePanel = useCallback(() => setPanel((p) => ({ open: !p.open, expanded: p.open ? null : p.expanded })), []);
  const openCount = margin.length + orphaned.length;
  const ui = useMemo<CommentsUI>(
    () => ({ start, panelOpen: panel.open, togglePanel, openCount, canRead }),
    [start, panel.open, togglePanel, openCount, canRead],
  );

  const myName = authors.find((p) => p.userId === userId)?.name?.trim() || "You";
  const composer = draft && ctx && (
    <div className="nt-comment-draft">
      <div className="nt-comment-head">
        <span aria-hidden className="nt-monogram nt-comment-face">
          {initials(myName)}
        </span>
        <span className="nt-comment-name">{myName}</span>
      </div>
      <CommentComposer
        key={`${draft.from}:${draft.to}`}
        people={mentionable}
        label="Comment"
        placeholder="Comment or add others with @"
        submitLabel="Comment"
        autoFocus
        onCancel={cancelDraft}
        onSubmit={submitDraft}
      />
    </div>
  );

  return (
    <CommentsUIContext value={ui}>
      {children}
      {view && ctx && canRead && (
        <CommentMargin
          view={view}
          threads={margin}
          draft={mode === "cards" ? composer : null}
          focused={focused}
          mode={mode}
          onMode={setMode}
          notices={notices}
          ctx={ctx}
          onDot={openThread}
        />
      )}
      {readOnly && selection && !draft && view && <SelectionAffordance view={view} selection={selection} onComment={start} />}
      {comments?.refusal && canRead && (
        <div className="nt-update nt-comment-refused" role="alert">
          <span>Your comment change was not saved. {comments.refusal}</span>
          <button className="nt-update-x" aria-label="Dismiss" onClick={comments.dismissRefusal}>
            ×
          </button>
        </div>
      )}
      {(panel.open || (draft && mode === "dots")) && ctx && canRead && view && (
        <CommentsPanel
          view={view}
          ctx={ctx}
          open={margin}
          orphaned={orphaned}
          resolved={resolved}
          expanded={panel.expanded}
          focused={active}
          notices={notices}
          draft={mode === "dots" ? composer : null}
          quote={draft?.anchor.exact ?? null}
          onExpand={expand}
          onOpen={openThread}
          onClose={closePanel}
        />
      )}
    </CommentsUIContext>
  );
}
