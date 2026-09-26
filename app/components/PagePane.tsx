"use client";

import { useLayoutEffect, useRef, type FocusEventHandler, type PointerEventHandler, type ReactNode } from "react";
import { usePageFit } from "@/app/lib/columnScale";
import { zoomFor, type ZoomPane } from "@/app/lib/docZoom";
import { useDocumentZoom } from "./useDocumentZoom";

/**
 * A page in its pane: the scroller, the sheet the document zoom magnifies, and
 * the column the page's words stand in.
 *
 * The zoom sits on the sheet and never on the scroller: ProseMirror scrolls the
 * caret into view by client-px deltas on its scroll parent, which only hold
 * while that parent is unzoomed. The sheet is unpositioned, unclipped and
 * untransformed on purpose — anything else would make it the containing block
 * of every fixed overlay inside the page.
 */
export function PagePane({
  pane,
  pageId,
  idle = false,
  busy = false,
  onPointerDownCapture,
  onFocusCapture,
  children,
}: {
  /** Whose zoom this page takes; none for a placeholder. */
  pane?: ZoomPane;
  /** Each page opens at 100%. */
  pageId?: string;
  idle?: boolean;
  /** A skeleton: announced as loading, and never scrolled. */
  busy?: boolean;
  onPointerDownCapture?: PointerEventHandler<HTMLElement>;
  onFocusCapture?: FocusEventHandler<HTMLElement>;
  children: ReactNode;
}) {
  const paneRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  usePageFit(paneRef, sheetRef);
  useDocumentZoom(pane ?? null, paneRef, sheetRef);
  useLayoutEffect(() => {
    if (pane) zoomFor(pane).reset();
  }, [pane, pageId]);

  return (
    <main
      ref={paneRef}
      className={`nt-pane flex flex-1 flex-col ${busy ? "overflow-hidden" : "overflow-auto"}${idle ? " is-idle" : ""}`}
      aria-busy={busy || undefined}
      data-page-id={pageId}
      data-pane={pane}
      onPointerDownCapture={onPointerDownCapture}
      onFocusCapture={onFocusCapture}
    >
      <div ref={sheetRef} className="nt-sheet">
        {/* Grows to fill the pane so the empty room under the last block still
            belongs to the document — that is where a hand reaches to start a
            box selection, and a content-height column would leave it to the
            scroller. */}
        <div className="nt-column mx-auto flex w-full flex-1 flex-col py-12 sm:py-20">
          {children}
        </div>
      </div>
    </main>
  );
}
