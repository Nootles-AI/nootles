"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { FocusDomain } from "@/app/lib/history/focusDomain";
import { awaitSurface } from "@/app/lib/history/surfaceRegistry";
import {
  undoScope,
  useWorkspaceHistory,
  WorkspaceHistoryProvider,
} from "@/app/lib/history/useWorkspaceHistory";
import { LayersPanel } from "./editor/canvas/panels/LayersPanel";
import { Toolbar } from "./editor/canvas/Toolbar";
import {
  CanvasShellContext,
  CanvasStylePanel,
  type ActiveCanvas,
} from "./editor/canvas/shell";
import { LocationPanel } from "./editor/location/LocationPanel";
import { LocationShellContext, type ActiveLocation } from "./editor/location/shell";
import { useOpenPage } from "./OpenPageContext";
import { Sidebar } from "./Sidebar";
import { PageSurface } from "./PageSurface";
import { ChatPanel } from "./ChatPanel";
import { ReviewBar } from "./ReviewBar";
import { ResizeHandle } from "./ResizeHandle";
import { PanelsProvider } from "./PanelsContext";
import { PagesProvider, type PageRef } from "./PagesContext";
import { CompletionContextProvider } from "./editor/ai/CompletionContext";
import { ReadOnlyContext } from "./editor/readOnly";
import { Facepile } from "./presence/Facepile";
import { Hints } from "./hints/Hints";
import { Feedback } from "./feedback/Feedback";
import { FixedToast } from "./feedback/FixedToast";
import { AccessRequests } from "./share/AccessRequests";
import { TesterNote } from "./feedback/TesterNote";
import { PmfSurvey } from "./feedback/PmfSurvey";
import { DismissSampler } from "./feedback/DismissSampler";
import { PanelLeft, PanelRight } from "./Icons";

const LEFT = { def: 256, min: 200, max: 480 };
const RIGHT = { def: 320, min: 260, max: 560 };
/* A split is held as a share of the column rather than a width in it, so the
   two panes keep their proportions as the rails open, close and resize under
   them — and neither can be squeezed out of existence. */
const SPLIT = { def: 0.5, min: 0.25, max: 0.75 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/* The three widths, as custom properties on the shell rather than numbers
   passed down. A drag can then write the live value straight to the DOM and
   leave React alone until the pointer is released — the alternative is a render
   of the sidebar, both documents and the transcript per frame of a rail drag. */
const VARS = { left: "--nt-left", right: "--nt-right", aside: "--nt-aside" };
const LEFT_W = `var(${VARS.left})`;
const RIGHT_W = `var(${VARS.right})`;
const DRAWER_W = "288px";

/* Below this the three fixed panels leave no usable column for the document
   (462px of chrome against a 560px viewport left 2px of text), so they stop
   being in-flow and become overlays the user summons. */
const COMPACT = "(max-width: 1023px)";

/* Everything that belongs to the canvas being edited. A press anywhere else is
   what "deselect" means — and the panels have to be in here, because a field in
   one takes focus off the canvas without meaning to leave it. The mention menu
   is portalled to the body but belongs to a label edit inside the canvas; the
   storyboard's fullscreen shot is a whole canvas view portalled the same way. */
const CANVAS_SHELL =
  ".nt-canvas, .nt-lyr, .nt-style-panel, .nt-toolbar, .nt-mention-anchor, .nt-sb-full";

/* The same idea for a place card: a press inside the card or its panel is
   still about that card, and anywhere else is done with it. */
const LOCATION_SHELL = ".nt-loc, .nt-style-panel";

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

/**
 * Where the shell has the pointer's attention — a claimed diagram, a chosen
 * place card, or neither. A focus stop on the workspace timeline, so undo
 * re-traces the way the user moved between surfaces (Figma's model).
 */
type WorkspaceFocus =
  | { kind: "none" }
  | { kind: "canvas" | "place"; pageId: string | null; blockId: string };

const focusKey = (f: WorkspaceFocus) =>
  f.kind === "none" ? "none" : `${f.kind}:${f.blockId}`;

export function Workspace({ projectId }: { projectId: Id<"projects"> }) {
  return (
    <WorkspaceHistoryProvider projectId={projectId}>
      <WorkspaceInner projectId={projectId} />
    </WorkspaceHistoryProvider>
  );
}

function WorkspaceInner({ projectId }: { projectId: Id<"projects"> }) {
  const { main, aside, focus, open, openAside } = useOpenPage();

  const [leftWidth, setLeftWidth] = useState(LEFT.def);
  const [rightWidth, setRightWidth] = useState(RIGHT.def);
  const [asideShare, setAsideShare] = useState(SPLIT.def);
  /* The document column: both panes, and the half of it a page can be dropped
     into to open beside the one already there. */
  const columnRef = useRef<HTMLDivElement>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);

  const [canvas, setCanvas] = useState<ActiveCanvas | null>(null);
  const [place, setPlace] = useState<ActiveLocation | null>(null);

  // ---- The workspace history spine ---------------------------------------
  // The shell's claims are focus history (a stop on the timeline), and the
  // spine's steps can lead to other pages — so the workspace supplies both
  // the recording wrappers around its own setters and the navigator.
  const spine = useWorkspaceHistory();
  const pageRef = useRef<string | null>(null);
  const openRef = useRef(open);
  const canvasRef = useRef(canvas);
  const placeRef = useRef(place);
  useEffect(() => {
    openRef.current = open;
    canvasRef.current = canvas;
    placeRef.current = place;
  });

  useEffect(() => {
    if (!spine) return;
    spine.setNavigator({
      currentPage: () => pageRef.current,
      openPage: (pageId) => openRef.current(pageId as Id<"pages">),
    });
    return () => spine.setNavigator(null);
  }, [spine]);

  const applyFocus = useCallback((state: WorkspaceFocus) => {
    if (state.kind === "none") {
      setCanvas(null);
      setPlace(null);
      return;
    }
    if (state.pageId && pageRef.current !== state.pageId) {
      openRef.current(state.pageId as Id<"pages">);
    }
    // The block claims the shell itself once it is mounted — after the
    // navigation above, when the restore crossed a page.
    void awaitSurface(state.blockId).then((claim) => claim?.());
  }, []);
  // Held in a ref: only event handlers and the spine ever reach it, and the
  // linter rightly refuses render-phase access to ref-reading closures.
  const focusDomainRef = useRef<FocusDomain<WorkspaceFocus> | null>(null);
  useEffect(() => {
    if (!spine) return;
    const domain = new FocusDomain<WorkspaceFocus>(spine, "focus", applyFocus);
    focusDomainRef.current = domain;
    const unregister = spine.register("focus", domain);
    return () => {
      focusDomainRef.current = null;
      unregister();
    };
  }, [spine, applyFocus]);

  const describeFocus = useCallback(
    (c: ActiveCanvas | null, p: ActiveLocation | null): WorkspaceFocus =>
      c
        ? { kind: "canvas", pageId: pageRef.current, blockId: c.blockId }
        : p
          ? { kind: "place", pageId: pageRef.current, blockId: p.blockId }
          : { kind: "none" },
    [],
  );
  const claimCanvas = useCallback(
    (next: ActiveCanvas | null) => {
      const domain = focusDomainRef.current;
      const before = describeFocus(canvasRef.current, placeRef.current);
      const after = describeFocus(next, placeRef.current);
      if (domain && focusKey(before) !== focusKey(after)) {
        domain.record(before, after);
      }
      setCanvas(next);
    },
    [describeFocus],
  );
  const claimPlace = useCallback(
    (next: ActiveLocation | null) => {
      const domain = focusDomainRef.current;
      const before = describeFocus(canvasRef.current, placeRef.current);
      const after = describeFocus(canvasRef.current, next);
      if (domain && focusKey(before) !== focusKey(after)) {
        domain.record(before, after);
      }
      setPlace(next);
    },
    [describeFocus],
  );

  const shell = useMemo(
    () => ({ active: canvas, set: claimCanvas }),
    [canvas, claimCanvas],
  );
  const placeShell = useMemo(
    () => ({ active: place, set: claimPlace }),
    [place, claimPlace],
  );

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
  // A selected place card takes the right rail the same way, and yields to a
  // diagram: editing one is a whole mode, choosing what a card shows is not.
  const placePanel = compact || canvas ? null : place;

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
      if (!target?.closest(CANVAS_SHELL)) claimCanvas(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [editing, claimCanvas]);

  const chosen = place !== null;
  useEffect(() => {
    if (!chosen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(LOCATION_SHELL)) claimPlace(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [chosen, claimPlace]);

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

  /* The live value goes to the DOM; only the release goes to React, which is
     what keeps a drag off the document and the transcript. */
  const shellRef = useRef<HTMLDivElement>(null);
  const write = useCallback((name: string, value: string) => {
    shellRef.current?.style.setProperty(name, value);
  }, []);

  const onResizeLeft = useCallback(
    (clientX: number, done: boolean) => {
      const width = clamp(clientX, LEFT.min, LEFT.max);
      if (done) setLeftWidth(width);
      else write(VARS.left, `${width}px`);
    },
    [write],
  );
  const onResizeRight = useCallback(
    (clientX: number, done: boolean) => {
      const width = clamp(window.innerWidth - clientX, RIGHT.min, RIGHT.max);
      if (done) setRightWidth(width);
      else write(VARS.right, `${width}px`);
    },
    [write],
  );
  // Measured against the column rather than the window: what is left of it
  // after the rails is all the two panes have to share.
  const onResizeAside = useCallback(
    (clientX: number, done: boolean) => {
      const box = columnRef.current?.getBoundingClientRect();
      if (!box) return;
      const share = clamp((box.right - clientX) / box.width, SPLIT.min, SPLIT.max);
      if (done) setAsideShare(share);
      else write(VARS.aside, `${share * 100}%`);
    },
    [write],
  );

  // The project comes from the route now. Only the pages are a selection, and
  // they are derived rather than synced via effects: each pane holds the
  // explicit override — whoever made it, the sidebar or the agent — and when
  // unset or stale the main column falls back to the first page.
  const pages = useQuery(api.pages.listByProject, { projectId });
  // Which chrome this workspace wears: viewers read (no chat, no editing),
  // editors write, only the owner shares and administers. The same surface
  // serves all three — a shared project must not feel like a lesser app.
  const role = useQuery(api.projects.myRole, { projectId });
  const viewer = role === "viewer";
  const sortedPages = useMemo(
    () => (pages ? [...pages].sort((a, b) => a.order - b.order) : undefined),
    [pages],
  );
  /* Named pages, and nothing else about them. The context reaches through
     BlockNote's node views into mention chips and shape labels, so it must not
     churn on a shell render or carry a field they never read. */
  const pageRefs = useMemo(
    () =>
      sortedPages?.map((p) => ({
        _id: p._id,
        title: p.title,
        icon: p.icon as PageRef["icon"],
      })) ?? null,
    [sortedPages],
  );
  const known = (id: Id<"pages"> | null | undefined) =>
    id && sortedPages?.some((p) => p._id === id) ? id : null;
  /* The row this list already holds, handed to the pane so its document can
     start loading without waiting for a `pages.get` of its own. */
  const rowFor = (id: Id<"pages">) => sortedPages?.find((p) => p._id === id);
  const mainPageId = known(main.page) ?? sortedPages?.[0]?._id ?? null;
  // The second pane shows exactly what it was asked to, deleted page and all:
  // it says so in its own words and the close button is right there, which is
  // better than a column that vanishes out from under you. It stays until it
  // is closed — a pane that is open is a pane you can see, and that is what
  // makes "the focused one" an answer the sidebar and the agent can trust.
  const asidePageId = aside?.page ?? null;
  // Only the chat is spared a page that is gone; it would have nothing to read.
  const effectivePageId =
    (focus === "aside" ? known(asidePageId) : null) ?? mainPageId;

  // What the spine's navigator answers with — always the focused pane's page.
  useEffect(() => {
    pageRef.current = effectivePageId ?? null;
  });

  const sidebar = (
    <Sidebar
      width={compact ? DRAWER_W : LEFT_W}
      projectId={projectId}
      selectedPageId={effectivePageId}
      otherPageId={focus === "aside" ? mainPageId : asidePageId}
      splitZone={columnRef}
      onOpenAside={openAside}
      onSelectPage={(id) => {
        open(id);
        setDrawer(null);
      }}
      onCollapse={() => (compact ? setDrawer(null) : setLeftOpen(false))}
    />
  );

  const chat = (
    <ChatPanel
      width={compact ? DRAWER_W : RIGHT_W}
      projectId={projectId}
      pageId={effectivePageId}
      onCollapse={() => (compact ? setDrawer(null) : setRightOpen(false))}
    />
  );

  return (
    <CanvasShellContext value={shell}>
      <LocationShellContext value={placeShell}>
     <ReadOnlyContext value={viewer}>
     <PagesProvider pages={pageRefs}>
     <CompletionContextProvider projectId={projectId}>
     <PanelsProvider value={panels}>
      <div
        ref={shellRef}
        className="flex h-screen w-full overflow-hidden"
        style={
          {
            [VARS.left]: `${leftWidth}px`,
            [VARS.right]: `${rightWidth}px`,
            [VARS.aside]: `${asideShare * 100}%`,
          } as CSSProperties
        }
      >
        {canvasPanels ? (
          <>
            <aside
              className="nt-panel nt-rail-l"
              style={{ width: LEFT_W }}
              aria-label="Layers"
              {...undoScope}
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

        <div ref={columnRef} className="relative flex min-w-0 flex-1">
          {/* The workspace has no top bar, so presence floats where a top
              bar's corner would be — over the focused document. */}
          <div
            className="pointer-events-none absolute right-3 top-3"
            style={{ zIndex: "var(--z-sticky)" }}
          >
            <Facepile
              docId={
                sortedPages?.find((p) => p._id === effectivePageId)?.docId ??
                null
              }
            />
          </div>
          {mainPageId ? (
            <PageSurface
              pageId={mainPageId}
              pane="main"
              row={rowFor(mainPageId)}
            />
          ) : (
            <EmptyWorkspace />
          )}
          {asidePageId && (
            <>
              <ResizeHandle onResize={onResizeAside} ariaLabel="Resize split" />
              <div
                className="flex min-w-0 shrink-0"
                style={{ width: `var(${VARS.aside})` }}
              >
                <PageSurface
                  pageId={asidePageId}
                  pane="aside"
                  row={rowFor(asidePageId)}
                />
              </div>
            </>
          )}
        </div>

        {/* Viewers have no chat: their AI would need the pen. No rail, no
            edge tab — absence, not a locked door. */}
        {canvasPanels ? (
          <CanvasStylePanel api={canvasPanels.api} />
        ) : placePanel ? (
          <LocationPanel active={placePanel} />
        ) : viewer ? null : showRight ? (
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
          {/* A storyboard shot claims the shell for the panels but carries its
              own vertical bar beside the board, so the floating pill stands
              down for it the way it does for a review. */}
          {canvas && !canvas.api.board ? (
            <Toolbar
              store={canvas.api.store}
              viewport={canvas.api.viewport}
              tools={canvas.api.tools}
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

        <Feedback projectId={projectId} pageId={effectivePageId} />
        {/* The answer to what that button sent, in the corner it left from. */}
        <FixedToast />
        {/* Not this project's — the caller's, wherever they are standing. */}
        <AccessRequests />
        <TesterNote projectId={projectId} />
        <PmfSurvey />
        <DismissSampler />

        {/* Renders nothing itself — it feeds the surfaces their first-touch
            hints while the seeded project still has lessons left. */}
        <Hints projectId={projectId} pageId={effectivePageId} />
      </div>
     </PanelsProvider>
     </CompletionContextProvider>
     </PagesProvider>
     </ReadOnlyContext>
      </LocationShellContext>
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
