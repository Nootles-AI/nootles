"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { EntryDomain } from "@/app/lib/history/entryDomain";
import {
  undoScope,
  useWorkspaceHistory,
} from "@/app/lib/history/useWorkspaceHistory";
import { Editable } from "./Editable";
import { useRenamePage } from "./renamePage";
import { Editor } from "./editor/Editor";
import { BodySkeleton } from "./editor/BodySkeleton";
import { useEditorRegistry } from "./editor/EditorRegistry";
import { leaveTitle, TITLE_ATTR } from "./editor/titleBoundary";
import { CurrentPageProvider, useOpenPage, type Pane } from "./OpenPageContext";
import { ArrowLeft, X } from "./Icons";
import { useReadOnly } from "./editor/readOnly";
import { PageCommentsProvider } from "./comments/PageComments";
import { CommentsLayer } from "./comments/CommentsLayer";
import { CommentsButton } from "./comments/CommentsButton";
import { useCornerSlot } from "./cornerSlot";
import { usePageCommands } from "./pageCommands";
import type { PageMode } from "./editor/ai/useTabCompletion";

/** Mirrors the real column so the title and first paragraphs land in place. */
export function PageSkeleton() {
  return (
    <main className="flex flex-1 flex-col overflow-hidden" aria-busy="true">
      <div
        className="mx-auto w-full px-6 py-12 sm:px-14 sm:py-20"
        style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
      >
        <div className="nt-skeleton mt-[4.5rem] h-10 w-1/2" />
        <div className="mt-4">
          <BodySkeleton />
        </div>
      </div>
    </main>
  );
}

export function PageSurface({
  pageId,
  pane,
  row,
}: {
  pageId: Id<"pages">;
  /** Which column this is; the second one can be closed, and both take focus. */
  pane: Pane;
  /**
   * This page's row from the workspace's own list, when it holds one.
   *
   * The document cannot start loading until its `docId` is known, and waiting
   * for `pages.get` to say so put the whole editor chain a round trip behind a
   * fact the workspace already had in hand. `get` still runs — it is what keeps
   * the title live and what answers for a page that has been deleted — but it
   * is no longer what the first paint waits on.
   */
  row?: Doc<"pages">;
}) {
  const live = useQuery(api.pages.get, { pageId });
  const page = live === undefined ? row : live;
  const rename = useRenamePage();
  const setMode = useMutation(api.pages.setMode);
  // Provided by the workspace for viewer-role visitors; the whole column obeys.
  const readOnly = useReadOnly();
  const { main, aside, focus, back, closeAside, focusPane } = useOpenPage();
  const registry = useEditorRegistry();
  const cornerSlot = useCornerSlot();
  const modeCommandRef = usePageCommands();
  const canGoBack = (pane === "aside" ? aside : main)?.canGoBack ?? false;
  /** Only ever true beside another pane: alone, a page is the one you are in. */
  const idle = aside !== null && focus !== pane;

  // Persist title edits on a debounce. The Editable owns the text; we only read
  // it on input and write through.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // The page row's place on the workspace timeline — its title and its mode
  // persist through mutations, not the Y doc, so each commit records an entry
  // holding the prior value, and undo writes it back through the same verb.
  const spine = useWorkspaceHistory();
  const pageDomainRef = useRef<EntryDomain | null>(null);
  useEffect(() => {
    if (!spine) return;
    const domain = new EntryDomain(spine, `page:${pageId}`);
    pageDomainRef.current = domain;
    const unregister = spine.register(`page:${pageId}`, domain, pageId);
    return () => {
      pageDomainRef.current = null;
      unregister();
    };
  }, [spine, pageId]);
  // A page opening rises into place, once: the title, then the body a beat
  // behind it. The surface is not remounted between pages, so the entrance is
  // replayed by renaming the animation — `turn` flips with every page, and a
  // changed `animation-name` is a new animation. Counted during render, from
  // the prop, like any derived value; typing never touches it.
  const [opened, setOpened] = useState({ pageId, turn: 0 });
  if (opened.pageId !== pageId) setOpened({ pageId, turn: opened.turn + 1 });
  const turn = opened.turn % 2 === 0 ? "a" : "b";
  /** The last title this surface knows to be persisted — the entry's "before". */
  const committedTitle = useRef<string | null>(null);
  const titleHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    committedTitle.current = null;
  }, [pageId]);
  useEffect(() => {
    // Mirror the live row while no edit is pending — an undo, or a rename
    // from the sidebar, moves the baseline the next entry diffs against.
    if (page && debounceRef.current === null) committedTitle.current = page.title;
  });
  // The suggestion mode lives in ⌘K now; the main page answers for it there,
  // and still records the change on its own timeline.
  useEffect(() => {
    if (!modeCommandRef || pane !== "main" || readOnly || !page) return;
    const before = (page.mode ?? "create") as PageMode;
    const command = {
      mode: before,
      set: (mode: PageMode) => {
        if (mode === before) return;
        void setMode({ pageId, mode });
        pageDomainRef.current?.record({
          undo: () => setMode({ pageId, mode: before }),
          redo: () => setMode({ pageId, mode }),
        });
      },
    };
    modeCommandRef.current = command;
    return () => {
      if (modeCommandRef.current === command) modeCommandRef.current = null;
    };
  });

  if (page === undefined) return <PageSkeleton />;
  if (page === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        Page not found
      </div>
    );
  }

  /** Write a title back — an undo or redo landing. The Editable only accepts
   *  pushed values while unfocused, so a caret sitting in the title lets go. */
  const restoreTitle = (title: string) => {
    committedTitle.current = title;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      titleHost.current?.contains(active)
    ) {
      active.blur();
    }
    return rename({ pageId, title }).then(() => {});
  };

  /** Write the title now, and record it — anything still debounced folds in. */
  const commitTitle = (text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const before = committedTitle.current ?? "";
    if (text === before) return;
    committedTitle.current = text;
    void rename({ pageId, title: text });
    pageDomainRef.current?.record({
      undo: () => restoreTitle(before),
      redo: () => restoreTitle(text),
    });
  };

  const persistTitle = (text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commitTitle(text), 400);
  };

  return (
    <CurrentPageProvider pageId={pageId}>
    {/* Focus on the way down, before any click inside lands: what the chat and
        the agent act on is the pane you last put a pointer or a caret in, and
        every verb that navigates — a followed chip, the back arrow — reads the
        same answer. */}
    <main
      className={`nt-pane flex flex-1 flex-col overflow-auto${idle ? " is-idle" : ""}`}
      data-page-id={pageId}
      onPointerDownCapture={() => focusPane(pane)}
      onFocusCapture={() => focusPane(pane)}
    >
      {/* Centred in the pane, text still left-aligned. The cost is known:
          the column is measured against the room the panels leave, so opening
          or collapsing a panel moves the text. The left gutter also houses
          BlockNote's drag handle and + button. */}
      {/* Grows to fill the pane so the empty room under the last block still
          belongs to the document — that is where a hand reaches to start a box
          selection, and a content-height column would leave it to the scroller. */}
      <div
        className="mx-auto flex w-full flex-1 flex-col px-6 py-12 sm:px-14 sm:py-20"
        style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
      >
        <PageCommentsProvider pageId={pageId}>
        <CommentsLayer linked={pane === "main"}>
        <div className="mb-10 flex min-h-7 items-center justify-start gap-2">
          {/* Following a chip somewhere needs a way home. Present only once
              there is a "back" to mean — a standing button would be chrome. */}
          {canGoBack && (
            <button
              onClick={() => back(pane)}
              aria-label="Back to previous page"
              title="Back to previous page"
              className="nt-icon-btn"
            >
              <ArrowLeft />
            </button>
          )}
          <div className="ml-auto flex items-center gap-1">
            {pane === "main" && cornerSlot ? (
              createPortal(<CommentsButton />, cornerSlot)
            ) : (
              <CommentsButton />
            )}
            {pane === "aside" && (
              <button
                onClick={closeAside}
                aria-label="Close split"
                title="Close split"
                className="nt-icon-btn"
              >
                <X />
              </button>
            )}
          </div>
        </div>
        {readOnly ? (
          <h1
            data-turn={turn}
            className="nt-page-in is-title w-full text-[length:var(--text-page-title)] font-semibold tracking-[-0.02em] text-balance"
          >
            {page.title || "Untitled"}
          </h1>
        ) : (
        <div
          ref={titleHost}
          className="nt-page-in is-title"
          data-turn={turn}
          {...{ [TITLE_ATTR]: "" }}
          {...undoScope}
        >
        <Editable
          value={page.title}
          onInput={persistTitle}
          onKeyDown={(e) => leaveTitle(e, () => registry.editorFor(pageId), commitTitle)}
          placeholder="Untitled"
          label="Page title"
          className="w-full text-[length:var(--text-page-title)] font-semibold tracking-[-0.02em] text-balance"
        />
        </div>
        )}
        <div className="nt-page-in mt-4" data-turn={turn}>
          <Editor
            docId={page.docId}
            pageId={pageId}
            title={page.title}
            mode={(page.mode ?? "create") as PageMode}
            yjs={page.yjs}
          />
        </div>
        </CommentsLayer>
        </PageCommentsProvider>
      </div>
    </main>
    </CurrentPageProvider>
  );
}
