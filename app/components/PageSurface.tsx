"use client";

import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Editable } from "./Editable";
import { Editor } from "./editor/Editor";
import { RowIcon, type RowIconValue } from "./rowIcon";
import "./iconPicker.css";

/* A megabyte of emoji data hangs off this; it has no business in the shell's
   first-paint chunk when most page views never open it. */
const IconPicker = dynamic(
  () => import("./IconPicker").then((m) => m.IconPicker),
  { ssr: false },
);
import { useEditorRegistry } from "./editor/EditorRegistry";
import { ModeToggle } from "./ModeToggle";
import { CurrentPageProvider, useOpenPage, type Pane } from "./OpenPageContext";
import { ArrowLeft, X } from "./Icons";
import { useReadOnly } from "./editor/readOnly";
import type { PageMode } from "./editor/ai/useTabCompletion";

export function PageSurface({
  pageId,
  pane,
}: {
  pageId: Id<"pages">;
  /** Which column this is; the second one can be closed, and both take focus. */
  pane: Pane;
}) {
  const page = useQuery(api.pages.get, { pageId });
  const rename = useMutation(api.pages.rename);
  const setMode = useMutation(api.pages.setMode);
  const setIcon = useMutation(api.pages.setIcon);
  /** Where the picker opens, in viewport coordinates, once a trigger is hit. */
  const [picking, setPicking] = useState<{ x: number; y: number } | null>(null);
  const head = useRef<HTMLDivElement>(null);
  /* Opened against a FIXED anchor rather than absolutely inside the header.
     The page column is narrower than the picker on a phone and the pane
     scrolls, so an absolutely-placed panel was clipped by its own container —
     taking the close button with it. */
  const openPicker = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPicking({ x: r.left, y: r.bottom + 6 });
  };
  /* Focus lands on the header, not on the trigger: Remove swaps the icon
     button out for the "Add icon" offer, so the element that opened this may
     not exist by the time it closes. The container always does. */
  const closePicker = () => {
    setPicking(null);
    head.current?.focus();
  };
  // Provided by the workspace for viewer-role visitors; the whole column obeys.
  const readOnly = useReadOnly();
  const { main, aside, focus, back, closeAside, focusPane } = useOpenPage();
  const registry = useEditorRegistry();
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

  if (page === undefined) {
    // Mirrors the real column so the title and first paragraphs land in place.
    return (
      <main className="flex flex-1 flex-col overflow-hidden" aria-busy="true">
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
      </main>
    );
  }
  if (page === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        Page not found
      </div>
    );
  }

  const persistTitle = (text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => rename({ pageId, title: text }), 400);
  };

  return (
    <CurrentPageProvider pageId={pageId}>
    {/* Focus on the way down, before any click inside lands: what the chat and
        the agent act on is the pane you last put a pointer or a caret in, and
        every verb that navigates — a followed chip, the back arrow — reads the
        same answer. */}
    <main
      className={`nt-pane flex flex-1 flex-col overflow-auto${idle ? " is-idle" : ""}`}
      onPointerDownCapture={() => focusPane(pane)}
      onFocusCapture={() => focusPane(pane)}
    >
      {/* Anchored left, not centred. Centring measured the column against the
          space the panels left over, so collapsing chat slid every line of text
          sideways. A document surface should hold still, like a code editor.
          The left gutter also houses BlockNote's drag handle and + button. */}
      {/* Grows to fill the pane so the empty room under the last block still
          belongs to the document — that is where a hand reaches to start a box
          selection, and a content-height column would leave it to the scroller. */}
      <div
        className="flex w-full flex-1 flex-col px-6 py-12 sm:px-14 sm:py-20"
        style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
      >
        <div className="mb-6 flex items-center justify-start gap-2">
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
          {!readOnly && (
            <ModeToggle
              mode={(page.mode ?? "create") as PageMode}
              onChange={(mode) => setMode({ pageId, mode })}
            />
          )}
          {pane === "aside" && (
            <button
              onClick={closeAside}
              aria-label="Close split"
              title="Close split"
              className="nt-icon-btn ml-auto"
            >
              <X />
            </button>
          )}
        </div>
        {/* The icon sits with the title, and is set by clicking it — the
            gesture everyone already knows from the tools this resembles. With
            no icon there is nothing to click, so the offer appears on hover of
            the header rather than standing there as permanent chrome. */}
        <div ref={head} tabIndex={-1} className="nt-page-head relative flex items-center gap-2">
          {page.icon ? (
            readOnly ? (
              <span className="nt-page-icon">
                <RowIcon icon={page.icon as RowIconValue} kind="page" size={30} />
              </span>
            ) : (
              <button
                className="nt-page-icon"
                onClick={openPicker}
                aria-label="Change page icon"
                title="Change icon"
              >
                <RowIcon icon={page.icon as RowIconValue} kind="page" size={30} />
              </button>
            )
          ) : (
            !readOnly && (
              <button className="nt-page-addicon" onClick={openPicker}>
                Add icon
              </button>
            )
          )}
          {picking && !readOnly && (
            <div
              className="nt-iconpicker-anchor"
              style={{
                left: Math.max(8, Math.min(picking.x, window.innerWidth - 336)),
                top: Math.max(8, Math.min(picking.y, window.innerHeight - 372)),
              }}
            >
              <IconPicker
                icon={(page.icon ?? null) as RowIconValue | null}
                kind="page"
                onPick={(next) => {
                  void setIcon({ pageId, icon: next ?? undefined });
                  closePicker();
                }}
                onClose={closePicker}
              />
            </div>
          )}
        </div>
        {readOnly ? (
          <h1 className="w-full text-[length:var(--text-title)] font-semibold tracking-[-0.02em] text-balance">
            {page.title || "Untitled"}
          </h1>
        ) : (
        <Editable
          value={page.title}
          onInput={persistTitle}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            // Enter leaves the title for the document, the way it does in every
            // editor this one resembles. Blurring instead left the caret
            // nowhere at all, so the next thing typed went to the page rather
            // than into the page.
            const title = e.currentTarget;
            registry
              .editorFor(pageId)
              .then((editor) => {
                const first = editor.document[0];
                if (first) editor.setTextCursorPosition(first, "start");
                editor.focus();
              })
              // A document that never finished loading has nowhere to put the
              // caret; letting go of the title is better than trapping it.
              .catch(() => title.blur());
          }}
          placeholder="Untitled"
          label="Page title"
          className="w-full text-[length:var(--text-title)] font-semibold tracking-[-0.02em] text-balance"
        />
        )}
        <div className="mt-8">
          <Editor
            docId={page.docId}
            pageId={pageId}
            title={page.title}
            mode={(page.mode ?? "create") as PageMode}
          />
        </div>
      </div>
    </main>
    </CurrentPageProvider>
  );
}
