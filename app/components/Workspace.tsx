"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import { isApplePlatform, matchShortcut } from "./editor/canvas/engine/shortcuts";
import { useEditorRegistry } from "./editor/EditorRegistry";
import { PageToolbar, pageToolFor, usePageDraw, type PageTool } from "./PageDraw";
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
import { BarMorph } from "./BarMorph";
import { ResizeHandle } from "./ResizeHandle";
import { WorkspacePalette } from "./WorkspacePalette";
import { useLinger } from "@/app/lib/useLinger";
import { publishColumnEdges } from "@/app/lib/columnEdges";
import dynamic from "next/dynamic";

// Opened rarely, so it does not ride in the workspace's first bundle.
const ShortcutsDialog = dynamic(() => import("./ShortcutsDialog"), { ssr: false });
import { PanelsProvider } from "./PanelsContext";
import { PagesProvider, type PageRef } from "./PagesContext";
import { CompletionContextProvider } from "./editor/ai/CompletionContext";
import { useRepoNaming } from "./context/useRepoNaming";
import { ReadOnlyContext } from "./editor/readOnly";
import { Facepile } from "./presence/Facepile";
import { Hints } from "./hints/Hints";
import { Feedback } from "./feedback/Feedback";
import { FixedToast } from "./feedback/FixedToast";
import { Correspondence } from "./share/AccessRequests";
import { useLinkedPage } from "./comments/useLinkedPage";
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

/* A rail's width lives on its slot and faces as `--nt-rail-w`, which
   globals.css registers as not inherited. A drag writes the live value straight
   onto those few boxes and leaves React alone until the pointer is released —
   the alternative is a render of the sidebar, both documents and the transcript
   per frame. Not on the shell: an inherited property there restyled every
   element of the document on every pointer move. */
const RAIL_W = "--nt-rail-w";
const railWidth = (px: number) => ({ [RAIL_W]: `${px}px` }) as CSSProperties;
function writeRailWidth(slot: HTMLElement | null, px: number) {
  if (!slot) return;
  for (const el of [slot, ...slot.children] as HTMLElement[]) el.style.setProperty(RAIL_W, `${px}px`);
}
/** A canvas with no `screen` (none claimed) never changes, so this subscribe
 *  is a stable identity `useSyncExternalStore` can hold onto across renders. */
const NEVER_CHANGES = () => () => {};
/* What a rail holds fills its face; the face carries the width. */
const FILL = "100%";
const DRAWER_W = "288px";
/** How long a rail takes to close; `.nt-rail-slot` in globals.css agrees. */
const RAIL_MS = 320;
/** How long the tool bar takes to leave; `nt-toolbar-out` agrees. */
const TOOLS_MS = 200;

/* Below this the three fixed panels leave no usable column for the document
   (462px of chrome against a 560px viewport left 2px of text), so they stop
   being in-flow and become overlays the user summons. */
const COMPACT = "(max-width: 1023px)";

/* Everything that belongs to the canvas being edited. A press anywhere else is
   what "deselect" means — and the panels have to be in here, because a field in
   one takes focus off the canvas without meaning to leave it. The mention menu
   is portalled to the body but belongs to a label edit inside the canvas; the
   storyboard's fullscreen shot is a whole canvas view portalled the same way.

   So is every menu (`.nt-menu`): the inspector's selects, the toolbar's zoom
   and settings, the canvas's own context menu are all portalled to the body.
   Leaving them out made choosing from one a press "outside" — it let the
   diagram go and the stage fall shut mid-choice. Counting any open menu is
   safe: a menu is only open because its trigger was pressed, and a trigger
   outside the canvas has already let the diagram go before its menu exists.

   And the rails the panels stand in, edges and resize handles included: while a
   diagram is being edited both rails are its panels, so widening one — or a
   press that lands on its border — is adjusting the diagram's tools, not
   leaving it. The split between two pages (`.is-gap`) is the document's. */
const CANVAS_SHELL =
  ".nt-canvas, .nt-lyr, .nt-style-panel, .nt-toolbar, .nt-mention-anchor, .nt-sb-full, .nt-menu, " +
  ".nt-rail-slot, .nt-resize:not(.is-gap)";

/* The same idea for a place card: a press inside the card or its panel — or a
   menu one of them opened — is still about that card, and anywhere else is
   done with it. */
const LOCATION_SHELL = ".nt-loc, .nt-style-panel, .nt-menu";

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
  const [finding, setFinding] = useState(false);
  const [showingKeys, setShowingKeys] = useState(false);

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

  // Through the sidebar's own selection: one way to choose a page.
  useLinkedPage(open);

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
  useRepoNaming(projectId);

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
  // ⌘K finds a page, as it finds a project one screen up. Heard on the way
  // down, before the editor: there ⌘K is "link this selection", and it keeps
  // that meaning whenever there is a selection to link.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `?` lists the keys — a bare key, so it stands down wherever one could
      // be typing, and while another dialog has the floor.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = e.target as HTMLElement | null;
        if (el?.closest?.("input, textarea, [contenteditable='true'], [role='dialog']")) return;
        e.preventDefault();
        setShowingKeys(true);
        return;
      }
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const typing = (e.target as HTMLElement | null)?.closest?.("[contenteditable='true']");
      if (typing && !window.getSelection()?.isCollapsed) return;
      e.preventDefault();
      e.stopPropagation();
      setFinding((f) => !f);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

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

  // Minimal UI (STAGE): both rails and the toolbar/review slot unmount while
  // a claimed canvas has asked for it — a pure view-state read, no scene
  // store involved. `chrome` is false only for a minimal, claimed canvas;
  // every other combination (no canvas, or a canvas not in minimal) keeps
  // its chrome exactly as before.
  const screen = canvas?.api.screen;
  const minimal = useSyncExternalStore(
    screen?.subscribe ?? NEVER_CHANGES,
    () => screen?.get().minimal ?? false,
    () => false,
  );
  const chrome = !(canvas && minimal);


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
  const leftSlotRef = useRef<HTMLDivElement>(null);
  const rightSlotRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);

  /* The column's edges, for the boxes fixed to the window that stand in it
     (`columnEdges.ts`) — a surface portalled to the body, like the storyboard's
     full-size shot, included. Measured, not recomputed: the rails beside the
     column are a sidebar, a layers panel, an edge tab or nothing at all
     depending on the moment, and the column already knows what is left over.
     Its width changes whenever any of them does, which is what the observer
     watches — on every frame of a rail opening or closing. */
  useLayoutEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const measure = () => {
      // Narrow, the rails are drawers summoned over the document rather than
      // chrome standing beside it, so there is nothing to leave room for.
      const box = compact ? null : el.getBoundingClientRect();
      publishColumnEdges(
        box ? { left: box.left, right: window.innerWidth - box.right } : { left: 0, right: 0 },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      publishColumnEdges(null);
    };
  }, [compact]);

  const onResizeLeft = useCallback(
    (clientX: number, done: boolean) => {
      const width = clamp(clientX, LEFT.min, LEFT.max);
      if (done) setLeftWidth(width);
      else writeRailWidth(leftSlotRef.current, width);
    },
    [],
  );
  const onResizeRight = useCallback(
    (clientX: number, done: boolean) => {
      const width = clamp(window.innerWidth - clientX, RIGHT.min, RIGHT.max);
      if (done) setRightWidth(width);
      else writeRailWidth(rightSlotRef.current, width);
    },
    [],
  );
  // Measured against the column rather than the window: what is left of it
  // after the rails is all the two panes have to share.
  const onResizeAside = useCallback(
    (clientX: number, done: boolean) => {
      const box = columnRef.current?.getBoundingClientRect();
      if (!box) return;
      const share = clamp((box.right - clientX) / box.width, SPLIT.min, SPLIT.max);
      if (done) setAsideShare(share);
      else if (asideRef.current) asideRef.current.style.width = `${share * 100}%`;
    },
    [],
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
  // Any resolved role without the pen reads — a commenter included — so a
  // role added later fails closed to read-only rather than open to editing.
  const viewer = role != null && role !== "owner" && role !== "editor";
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


  // Each rail is one place with two faces: the pages or the layers on the
  // left, the chat or an inspector on the right. Entering a diagram does not
  // close one rail and open another — the place stays, and what is in it turns
  // over. Every face stays mounted for as long as it takes to leave.
  //
  // The panels a claim brings need the claim's API to render, and that is gone
  // the moment the diagram is let go; the last one is kept for the way out.
  const [lastCanvas, setLastCanvas] = useState(canvasPanels);
  if (canvasPanels && canvasPanels !== lastCanvas) setLastCanvas(canvasPanels);
  const [lastPlace, setLastPlace] = useState(placePanel);
  if (placePanel && placePanel !== lastPlace) setLastPlace(placePanel);

  // The tool bar leaves the same way, a beat after the diagram is let go, and
  // the review it shares the corner with waits until it has.
  const [lastTools, setLastTools] = useState(canvas);
  if (canvas && canvas !== lastTools) setLastTools(canvas);
  const toolsOn = chrome && !!canvas;
  const toolsHeld = useLinger(toolsOn, TOOLS_MS) && !!lastTools;

  // With no diagram in hand the bar stays, holding the page's own tools: a
  // shape armed there draws a new diagram onto the page. The page is only ever
  // armed while nothing is being edited, so a claim disarms it by itself.
  const registry = useEditorRegistry();
  const [heldPageTool, setPageTool] = useState<PageTool>("move");
  const pageBarOn = chrome && !viewer && !compact && !toolsOn;
  // Where the page bar is there to turn into, the diagram's bar morphs into it
  // on the way out rather than first sinking away.
  const canvasBarOn = toolsOn || (toolsHeld && !pageBarOn);
  const pageTool: PageTool = pageBarOn ? heldPageTool : "move";

  // A diagram just drawn onto the page opens with what was drawn selected.
  const arriving = useRef<{ blockId: string; select: string } | null>(null);
  useEffect(() => {
    const next = arriving.current;
    if (!canvas || next?.blockId !== canvas.blockId) return;
    arriving.current = null;
    canvas.api.selection.select([next.select]);
  }, [canvas]);
  usePageDraw({
    well: columnRef,
    tool: pageTool,
    registry,
    onTool: setPageTool,
    onDrawn: useCallback((blockId: string, nodeId: string) => {
      arriving.current = { blockId, select: nodeId };
      void awaitSurface(blockId).then((claim) => claim?.());
    }, []),
    onIntoDiagram: useCallback(() => setPageTool("move"), []),
  });

  // ⌥⇧ and a letter, the diagram's own keys, pick the page's tools — heard in
  // the editor too, since the modifiers are what keep them from being typing.
  // A diagram in hand answers them itself.
  useEffect(() => {
    if (!pageBarOn) return;
    const apple = isApplePlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && heldPageTool !== "move") {
        e.preventDefault();
        setPageTool("move");
        return;
      }
      // ⌥⇧ only: the tools' bare letters are the diagram's, and here they are typing.
      if (!e.altKey || !e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, math-field, [role='dialog']")) return;
      const next = pageToolFor(matchShortcut(e, apple));
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      setPageTool(next);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [pageBarOn, heldPageTool]);

  // The diagram being edited says so on its own element: its ground shows the
  // dots and its edge (`.nt-canvas[data-live]`). Written from here because the
  // shell is what knows which one it is, and as an attribute rather than state
  // so no canvas re-renders for it.
  useEffect(() => {
    const el = canvas?.api.viewport.containerRef.current?.closest<HTMLElement>(".nt-canvas");
    if (!el) return;
    el.dataset.live = "";
    return () => {
      delete el.dataset.live;
    };
  }, [canvas]);

  const pagesOn = chrome && showLeft && !canvasPanels;
  const layersOn = chrome && !!canvasPanels;
  const leftRail = pagesOn || layersOn;
  const pagesHeld = useLinger(pagesOn, RAIL_MS);
  const layersHeld = useLinger(layersOn, RAIL_MS) && !!lastCanvas;

  const rightClaimed = !!canvasPanels || !!placePanel;
  const chatOn = chrome && !viewer && showRight && !rightClaimed;
  const designOn = chrome && !!canvasPanels;
  const placeOn = chrome && !!placePanel;
  const rightRail = chatOn || designOn || placeOn;
  const chatHeld = useLinger(chatOn, RAIL_MS) && !compact;
  const designHeld = useLinger(designOn, RAIL_MS) && !!lastCanvas;
  const placeHeld = useLinger(placeOn, RAIL_MS) && !!lastPlace;

  const sidebar = (
    <Sidebar
      width={compact ? DRAWER_W : FILL}
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
      onFind={() => setFinding(true)}
      onShowKeys={() => setShowingKeys(true)}
    />
  );

  const chatAsDrawer = compact && openDrawer === "right";
  const chatProps = {
    width: compact ? DRAWER_W : FILL,
    projectId,
    pageId: effectivePageId,
    onCollapse: () => (compact ? setDrawer(null) : setRightOpen(false)),
    ...(chatAsDrawer
      ? {
          className: "fixed inset-y-0 right-0 shadow-2xl",
          style: { zIndex: "var(--z-modal)" },
        }
      : {}),
  };
  // Inspector panels replace the rail visually, but must not unmount ChatPanel:
  // its hook owns the BrowserChat and its abort signal. `hidden` keeps it out
  // of both layout and the accessibility tree while a canvas/location claims
  // the slot (or while the rail is collapsed), without mistaking that for Stop.
  const chatHidden = compact ? !chatAsDrawer : !chatOn && !chatHeld;

  return (
    <CanvasShellContext value={shell}>
      <LocationShellContext value={placeShell}>
     <ReadOnlyContext value={viewer}>
     <PagesProvider pages={pageRefs}>
     <CompletionContextProvider projectId={projectId}>
     <PanelsProvider value={panels}>
      <div className="nt-shell flex h-screen w-full overflow-hidden" data-bare={!chrome || undefined}>
        {/* The left rail's place. It closes over what it holds when the rail is
            put away, and turns its face over when a diagram takes it. */}
        {!compact && (
          <div ref={leftSlotRef} className="nt-rail-slot" data-open={leftRail} style={railWidth(leftWidth)}>
            {pagesHeld && (
              <div className="nt-rail-face" data-on={pagesOn} inert={!pagesOn} style={railWidth(leftWidth)}>
                {sidebar}
              </div>
            )}
            {layersHeld && lastCanvas && (
              <div className="nt-rail-face" data-on={layersOn} inert={!layersOn} style={railWidth(leftWidth)}>
                <aside
                  className="nt-panel"
                  style={{ width: FILL }}
                  aria-label="Layers"
                  {...undoScope}
                >
                  <LayersPanel
                    store={lastCanvas.api.store}
                    selection={lastCanvas.api.selection}
                  />
                </aside>
              </div>
            )}
          </div>
        )}
        {leftRail && !compact && (
          <ResizeHandle
            onResize={onResizeLeft}
            ariaLabel={canvasPanels ? "Resize layers" : "Resize sidebar"}
          />
        )}

        {/* Keep editor-local floating UI inside the document's paint layer.
            BlockNote's table handles carry their own z-index; without this
            boundary a hovered handle can outrank the sibling chat rail. No
            z-index of its own: the panels have none either, so DOM order
            settles the shell, and anything that must paint over the whole
            app (menus, dialogs, the block-handle cluster) portals to the
            body rather than fighting this boundary from inside. */}
        <div
          ref={columnRef}
          className="nt-well relative isolate flex min-w-0 flex-1"
          data-edge-l={!leftRail || undefined}
          data-edge-r={!rightRail || undefined}
        >
          {/* The workspace has no top bar, so presence floats where a top
              bar's corner would be — over the focused document. */}
          {/* A rail that is put away leaves its way back in the sheet's corner,
              on the side it went to. */}
          {chrome && !leftRail && (
            <div className="nt-corner is-left">
              <button
                onClick={() => (compact ? setDrawer("left") : setLeftOpen(true))}
                aria-label="Open sidebar"
                aria-expanded={openDrawer === "left"}
                title="Open sidebar"
                className="nt-icon-btn"
              >
                <PanelLeft />
              </button>
            </div>
          )}
          <div className="nt-corner is-right">
            <Facepile
              docId={
                sortedPages?.find((p) => p._id === effectivePageId)?.docId ??
                null
              }
            />
            {chrome && !viewer && !rightRail && (
              <button
                onClick={() => (compact ? setDrawer("right") : setRightOpen(true))}
                aria-label="Open chat"
                aria-expanded={openDrawer === "right"}
                title="Open chat"
                className="nt-icon-btn"
              >
                <PanelRight />
              </button>
            )}
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
              <ResizeHandle onResize={onResizeAside} ariaLabel="Resize split" gap />
              <div
                ref={asideRef}
                className="flex min-w-0 shrink-0"
                style={{ width: `${asideShare * 100}%` }}
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

        {rightRail && !compact && (
          <ResizeHandle
            onResize={onResizeRight}
            ariaLabel={chatOn ? "Resize chat" : "Resize panel"}
          />
        )}

        {/* The right rail's place: the chat, or what a diagram or a place card
            brings. Viewers have no chat — their AI would need the pen — so for
            them the place is only ever an inspector's.

            The one mounted ChatPanel keeps an active response alive wherever
            the chat happens to be shown; turning its face over, putting the
            rail away and the narrow drawer all only hide it. */}
        <div
          ref={rightSlotRef}
          className="nt-rail-slot is-right"
          data-open={rightRail && !compact}
          style={railWidth(rightWidth)}
        >
          {!viewer && (
            // Narrow, the chat is a fixed drawer, and a face mid-turn carries a
            // transform that would become what the drawer is fixed to — so
            // there it is not a face at all.
            <div
              className={compact ? "contents" : "nt-rail-face is-right"}
              style={railWidth(rightWidth)}
              data-on={chatOn}
              inert={!compact && !chatOn}
            >
              <ChatPanel {...chatProps} hidden={chatHidden} />
            </div>
          )}
          {designHeld && lastCanvas && (
            <div className="nt-rail-face is-right" data-on={designOn} inert={!designOn} style={railWidth(rightWidth)}>
              <CanvasStylePanel api={lastCanvas.api} />
            </div>
          )}
          {placeHeld && lastPlace && (
            <div className="nt-rail-face is-right" data-on={placeOn} inert={!placeOn} style={railWidth(rightWidth)}>
              <LocationPanel active={lastPlace} />
            </div>
          )}
        </div>

        {/* One bar, one corner. The tool palette is transient and the review is a
            standing question, so while a diagram is being edited the palette has
            the slot and the review comes back the moment the diagram is let go.
            The page's bar and the diagram's turn into one another. */}
        <BarMorph mode={toolsOn ? "canvas" : "page"}>
          {!chrome ? null : canvasBarOn && lastTools ? (
            <Toolbar
              key={lastTools.blockId}
              store={lastTools.api.store}
              viewport={lastTools.api.viewport}
              tools={lastTools.api.tools}
              screen={lastTools.api.screen}
              board={lastTools.api.board}
              onPalette={() => setFinding(true)}
              leaving={!toolsOn}
            />
          ) : (
            <>
              {pageBarOn && (
                <PageToolbar
                  tool={pageTool}
                  onTool={setPageTool}
                  onPalette={() => setFinding(true)}
                />
              )}
              {/* Here rather than under the editor: the changes it answers for
                  can span pages, and the agent opens pages on its own. */}
              <ReviewBar />
            </>
          )}
        </BarMorph>

        {openDrawer && (
          <>
            <button
              aria-label="Close panel"
              onClick={() => setDrawer(null)}
              className="fixed inset-0 bg-foreground/15"
              style={{ zIndex: "var(--z-overlay)" }}
            />
            {openDrawer === "left" && (
              <div
                className="fixed inset-y-0 left-0 shadow-2xl"
                style={{ zIndex: "var(--z-modal)" }}
              >
                {sidebar}
              </div>
            )}
          </>
        )}

        {finding && (
          <WorkspacePalette
            pages={sortedPages ?? []}
            currentPageId={effectivePageId}
            leftOpen={compact ? openDrawer === "left" : leftOpen}
            rightOpen={compact ? openDrawer === "right" : rightOpen}
            canChat={!viewer}
            onOpenPage={(id) => {
              open(id);
              setDrawer(null);
            }}
            onToggleLeft={() =>
              compact ? setDrawer((d) => (d === "left" ? null : "left")) : setLeftOpen((o) => !o)
            }
            onToggleRight={() =>
              compact ? setDrawer((d) => (d === "right" ? null : "right")) : setRightOpen((o) => !o)
            }
            onShowKeys={() => setShowingKeys(true)}
            onClose={() => setFinding(false)}
          />
        )}
        {showingKeys && <ShortcutsDialog onClose={() => setShowingKeys(false)} />}

        <Feedback projectId={projectId} pageId={effectivePageId} />
        {/* The answer to what that button sent, in the corner it left from. */}
        <FixedToast />
        {/* Not this project's — the caller's, wherever they are standing. */}
        <Correspondence projectId={projectId} />
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
