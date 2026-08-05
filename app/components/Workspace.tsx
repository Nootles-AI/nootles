"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { LayersPanel } from "./editor/canvas/panels/LayersPanel";
import { Toolbar } from "./editor/canvas/Toolbar";
import {
  CanvasShellContext,
  CanvasStylePanel,
  type ActiveCanvas,
} from "./editor/canvas/shell";
import { useOpenPage } from "./OpenPageContext";
import { Sidebar } from "./Sidebar";
import { PageSurface } from "./PageSurface";
import { ChatPanel } from "./ChatPanel";
import { ReviewBar } from "./ReviewBar";
import { ResizeHandle } from "./ResizeHandle";
import { PanelsProvider } from "./PanelsContext";
import { Tour } from "./tour/Tour";
import { FeedbackButton } from "./feedback/FeedbackButton";
import { PmfSurvey } from "./feedback/PmfSurvey";
import { DismissSampler } from "./feedback/DismissSampler";
import { PanelLeft, PanelRight } from "./Icons";

const LEFT = { def: 256, min: 200, max: 480 };
const RIGHT = { def: 320, min: 260, max: 560 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/* Below this the three fixed panels leave no usable column for the document
   (462px of chrome against a 560px viewport left 2px of text), so they stop
   being in-flow and become overlays the user summons. */
const COMPACT = "(max-width: 1023px)";

/* Everything that belongs to the canvas being edited. A press anywhere else is
   what "deselect" means — and the panels have to be in here, because a field in
   one takes focus off the canvas without meaning to leave it. */
const CANVAS_SHELL = ".nt-canvas, .nt-lyr, .nt-style-panel, .nt-toolbar";

/* Room left above a diagram too tall to centre. */
const REVEAL_TOP = 24;
/* Under this, the scroll is not worth the motion. */
const REVEAL_SLOP = 8;

/* The nearest ancestor that actually scrolls. The page column is the usual
   answer, but the editor nests a scroller of its own, so the question is asked
   of the tree rather than assumed. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    const scrolls = overflow === "auto" || overflow === "scroll";
    if (scrolls && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function Workspace({ projectId }: { projectId: Id<"projects"> }) {
  const { selected, open } = useOpenPage();

  const [leftWidth, setLeftWidth] = useState(LEFT.def);
  const [rightWidth, setRightWidth] = useState(RIGHT.def);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);

  const [canvas, setCanvas] = useState<ActiveCanvas | null>(null);
  const shell = useMemo(() => ({ active: canvas, set: setCanvas }), [canvas]);

  const compact = useMediaQuery(COMPACT);

  // Only what something outside needs: the first-run guide brings the chat rail
  // out before pointing at it. Rebuilt when `compact` flips because the same
  // verb means a drawer on a narrow screen and a rail on a wide one.
  const panels = useMemo(
    () => ({
      openChat: () => (compact ? setDrawer("right") : setRightOpen(true)),
      openSidebar: () => (compact ? setDrawer("left") : setLeftOpen(true)),
    }),
    [compact],
  );
  // Narrow: panels are overlays, and overlays start closed.
  const showLeft = leftOpen && !compact;
  const showRight = rightOpen && !compact;
  const openDrawer = compact ? drawer : null;
  // Editing a diagram turns both rails over to it, collapsed or not — but only
  // where there is room for them. The toolbar appears either way, and the
  // diagram is fully editable without the panels.
  const canvasPanels = compact ? null : canvas;

  // Restore persisted layout on the client. Defaults render first (so SSR and
  // the first client render match — no hydration mismatch), then we sync from
  // localStorage on mount; set-state-in-effect is the correct pattern here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const s = (k: string) => localStorage.getItem(k);
    const lw = Number(s("nt:leftWidth"));
    const rw = Number(s("nt:rightWidth"));
    if (lw) setLeftWidth(clamp(lw, LEFT.min, LEFT.max));
    if (rw) setRightWidth(clamp(rw, RIGHT.min, RIGHT.max));
    if (s("nt:leftOpen") === "0") setLeftOpen(false);
    if (s("nt:rightOpen") === "0") setRightOpen(false);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    localStorage.setItem("nt:leftWidth", String(leftWidth));
    localStorage.setItem("nt:rightWidth", String(rightWidth));
    localStorage.setItem("nt:leftOpen", leftOpen ? "1" : "0");
    localStorage.setItem("nt:rightOpen", rightOpen ? "1" : "0");
  }, [leftWidth, rightWidth, leftOpen, rightOpen]);

  const editing = canvas !== null;
  useEffect(() => {
    if (!editing) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(CANVAS_SHELL)) setCanvas(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [editing]);

  useEffect(() => {
    if (!openDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDrawer]);

  /* Whether a pointer is down anywhere. Read by the centring below, which must
     not move the page while one is. */
  const pressed = useRef(false);
  useEffect(() => {
    const down = () => (pressed.current = true);
    const up = () => (pressed.current = false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  /**
   * Entering a diagram brings it to the middle of the column.
   *
   * A canvas is usually half past the fold when you click into it, and
   * everything around it reorients at that moment — both rails turn over to it
   * and the toolbar comes to its edge. The diagram should be the thing you are
   * looking at when they do.
   *
   * Keyed on the block, not on `canvas`: that object is rebuilt whenever the
   * api changes, which includes picking a different tool, and re-centring the
   * page under someone who just pressed R would be its own kind of rude.
   */
  const activeCanvasId = canvas?.blockId ?? null;
  const activeCanvas = canvas?.api.viewport.containerRef;
  useEffect(() => {
    const el = activeCanvas?.current;
    if (!activeCanvasId || !el) return;

    const centre = () => {
      const scroller = scrollParent(el);
      if (!scroller) return;
      const box = el.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      // Centre what fits, and show the top of what does not: a diagram cropped
      // at both ends is worse than one that starts where you can see it.
      const offset = Math.max(REVEAL_TOP, (view.height - box.height) / 2);
      const top = scroller.scrollTop + (box.top - view.top) - offset;
      if (Math.abs(top - scroller.scrollTop) < REVEAL_SLOP) return;
      scroller.scrollTo({
        top,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    };

    // A block claims the shell on pointer-DOWN, so the press that opened this
    // canvas may still be the start of a drag on it — and the canvas measures
    // some drags in scene coordinates, which move when the page does. Scrolling
    // under a live drag would pull the shape out from under the cursor, so the
    // centring waits for the release. Activation from focus or the keyboard has
    // no press to wait for and lands at once.
    if (!pressed.current) {
      centre();
      return;
    }
    // The first release only, whichever kind it is — this canvas stays active
    // long after it, and every later click in the panels is a release too.
    let done = false;
    const onRelease = () => {
      if (done) return;
      done = true;
      stop();
      centre();
    };
    const stop = () => {
      window.removeEventListener("pointerup", onRelease, true);
      window.removeEventListener("pointercancel", onRelease, true);
    };
    window.addEventListener("pointerup", onRelease, true);
    window.addEventListener("pointercancel", onRelease, true);
    return stop;
  }, [activeCanvasId, activeCanvas]);

  const onResizeLeft = useCallback(
    (clientX: number) => setLeftWidth(clamp(clientX, LEFT.min, LEFT.max)),
    [],
  );
  const onResizeRight = useCallback(
    (clientX: number) =>
      setRightWidth(clamp(window.innerWidth - clientX, RIGHT.min, RIGHT.max)),
    [],
  );

  // The project comes from the route now. Only the page is a selection, and it
  // is derived rather than synced via effects: `selected` is the explicit
  // override — whoever made it, the sidebar or the agent — and when unset or
  // stale we fall back to the first page.
  const pages = useQuery(api.pages.listByProject, { projectId });
  const sortedPages = pages
    ? [...pages].sort((a, b) => a.order - b.order)
    : undefined;
  const effectivePageId =
    selected && sortedPages?.some((p) => p._id === selected)
      ? selected
      : (sortedPages?.[0]?._id ?? null);

  const sidebar = (
    <Sidebar
      width={compact ? 288 : leftWidth}
      projectId={projectId}
      selectedPageId={effectivePageId}
      onSelectPage={(id) => {
        open(id);
        setDrawer(null);
      }}
      onCollapse={() => (compact ? setDrawer(null) : setLeftOpen(false))}
    />
  );

  const chat = (
    <ChatPanel
      width={compact ? 288 : rightWidth}
      projectId={projectId}
      pageId={effectivePageId}
      onCollapse={() => (compact ? setDrawer(null) : setRightOpen(false))}
    />
  );

  return (
    <CanvasShellContext value={shell}>
     <PanelsProvider value={panels}>
      <div className="flex h-screen w-full overflow-hidden">
        {canvasPanels ? (
          <>
            <aside
              className="nt-panel nt-rail-l"
              style={{ width: leftWidth }}
              aria-label="Layers"
            >
              <LayersPanel
                store={canvasPanels.api.store}
                selection={canvasPanels.api.selection}
              />
            </aside>
            <ResizeHandle onResize={onResizeLeft} ariaLabel="Resize layers" />
          </>
        ) : showLeft ? (
          <>
            {sidebar}
            <ResizeHandle onResize={onResizeLeft} ariaLabel="Resize sidebar" />
          </>
        ) : (
          <EdgeRail
            side="left"
            onClick={() => (compact ? setDrawer("left") : setLeftOpen(true))}
            label="Open sidebar"
            expanded={openDrawer === "left"}
          />
        )}

        <div className="flex min-w-0 flex-1">
          {effectivePageId ? (
            <PageSurface pageId={effectivePageId} />
          ) : (
            <EmptyWorkspace />
          )}
        </div>

        {canvasPanels ? (
          <CanvasStylePanel api={canvasPanels.api} />
        ) : showRight ? (
          <>
            <ResizeHandle onResize={onResizeRight} ariaLabel="Resize chat" />
            {chat}
          </>
        ) : (
          <EdgeRail
            side="right"
            onClick={() => (compact ? setDrawer("right") : setRightOpen(true))}
            label="Open chat"
            expanded={openDrawer === "right"}
          />
        )}

        {/* One bar, one corner. The tool palette is transient and the review is a
            standing question, so while a diagram is being edited the palette has
            the slot and the review comes back the moment the diagram is let go.
            Both are fixed, and the resize handles carry a z-index of their own —
            hence the stacking context around this one. */}
        <div className="relative" style={{ zIndex: "var(--z-sticky)" }}>
          {canvas ? (
            <Toolbar
              store={canvas.api.store}
              viewport={canvas.api.viewport}
              tool={canvas.api.tool}
              onTool={canvas.api.setTool}
            />
          ) : (
            // Here rather than under the editor: the changes it answers for can
            // span pages, and the agent opens pages on its own.
            <ReviewBar />
          )}
        </div>

        {openDrawer && (
          <>
            <button
              aria-label="Close panel"
              onClick={() => setDrawer(null)}
              className="fixed inset-0 bg-foreground/15"
              style={{ zIndex: "var(--z-overlay)" }}
            />
            <div
              className={`fixed inset-y-0 ${
                openDrawer === "left" ? "left-0" : "right-0"
              } shadow-2xl`}
              style={{ zIndex: "var(--z-modal)" }}
            >
              {openDrawer === "left" ? sidebar : chat}
            </div>
          </>
        )}

        <FeedbackButton projectId={projectId} pageId={effectivePageId} />
        <PmfSurvey />
        <DismissSampler />

        {/* Last, and above everything: the guide draws over the workspace it is
            teaching. Renders nothing at all unless a tour is running. */}
        <Tour projectId={projectId} pageId={effectivePageId} />
      </div>
     </PanelsProvider>
    </CanvasShellContext>
  );
}

function EmptyWorkspace() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <p className="text-sm font-medium">No pages yet</p>
      <p className="max-w-xs text-sm text-muted">
        Press + in the sidebar to start one.
      </p>
    </div>
  );
}

/**
 * The rail shown in place of a collapsed panel. Its padding matches the panel's
 * own `--inset`, so the toggle button keeps its size and its distance from the
 * edge whether the panel is open or closed, instead of jumping.
 */
function EdgeRail({
  side,
  onClick,
  label,
  expanded,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
  expanded: boolean;
}) {
  return (
    <div className="flex h-full shrink-0 flex-col bg-surface p-2">
      <button
        onClick={onClick}
        aria-label={label}
        aria-expanded={expanded}
        title={label}
        className="nt-icon-btn"
      >
        {side === "left" ? <PanelLeft /> : <PanelRight />}
      </button>
    </div>
  );
}
