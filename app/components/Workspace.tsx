"use client";

import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import { useQuery } from "convex/react";
import * as Sentry from "@sentry/nextjs";
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
import { CanvasStylePanel } from "./editor/canvas/panels/CanvasStylePanel";
import { FrameToolbar, PageToolbar, SHAPES, ZoomToolbar } from "./editor/canvas/Toolbar";
import {
  createPageCanvasHub,
  PageCanvasHubContext,
  useHubSnapshot,
} from "./editor/canvas/page/PageCanvas";
import { FrameClaimContext, type ActiveFrame } from "./editor/canvas/page/frameClaim";
import { isApplePlatform, matchShortcut, type CanvasTool } from "./editor/canvas/engine/shortcuts";
import { LocationPanel } from "./editor/location/LocationPanel";
import { LocationShellContext, type ActiveLocation } from "./editor/location/shell";
import { useOpenPage } from "./OpenPageContext";
import { useZoomKeys } from "./useDocumentZoom";
import { Sidebar } from "./Sidebar";
import { PageSkeleton, PageSurface } from "./PageSurface";
import { ReviewBar } from "./ReviewBar";
import { ResizeHandle } from "./ResizeHandle";
import { COMPACT, DrawerScrim, LeftDrawer, drawerLayer } from "./Drawer";
import { WorkspacePalette } from "./WorkspacePalette";
import { useLinger } from "@/app/lib/useLinger";
import { publishColumnEdges } from "@/app/lib/columnEdges";
import dynamic from "next/dynamic";
import type { ChatPanel } from "./ChatPanel";

// Opened rarely, so it does not ride in the workspace's first bundle.
const ShortcutsDialog = dynamic(() => import("./ShortcutsDialog"), { ssr: false });
// The chat carries the AI SDK, so it loads beside the open rather than in
// front of it. React's own `lazy`, not `dynamic`: its fallback has to take the
// panel's props to hold the same place, hidden or drawn, as the panel will.
const loadChat = () =>
  lazy(() => import("./ChatPanel").then((m) => ({ default: m.ChatPanel })));
import { PanelsProvider } from "./PanelsContext";
import { PagesProvider, type PageRef } from "./PagesContext";
import { CompletionContextProvider } from "./editor/ai/CompletionContext";
import { useRepoNaming } from "./context/useRepoNaming";
import { ReadOnlyContext, readsOnly } from "./editor/readOnly";
import { CommentAccessContext, commentAccessFor } from "./comments/access";
import { Facepile } from "./presence/Facepile";
import { Hints } from "./hints/Hints";
import { Feedback } from "./feedback/Feedback";
import { FixedToast } from "./feedback/FixedToast";
import { Correspondence } from "./share/AccessRequests";
import { useLinkedPage } from "./comments/useLinkedPage";
import { PmfSurvey } from "./feedback/PmfSurvey";
import { DismissSampler } from "./feedback/DismissSampler";
import { PanelLeft, PanelRight } from "./Icons";
import { CornerSlotContext } from "./cornerSlot";

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
/* What a rail holds fills its face; the face carries the width. */
const FILL = "100%";
const DRAWER_W = "288px";
/** How long a rail takes to close; `.nt-rail-slot` in globals.css agrees. */
const RAIL_MS = 220;

/* Everything that belongs to a held storyboard shot. A press anywhere else lets
   it go — a diagram on the page included, which takes over. The panels have to
   be in here, because a field in one takes focus off the shot without meaning
   to leave it; so is the mention menu, portalled to the body but belonging to a
   label edit in the shot, and the full-size view, portalled the same way.

   So is every menu (`.nt-menu`): the inspector's selects, the toolbar's
   settings, the canvas's own context menu are all portalled to the body.
   Counting any open menu is safe: a menu is only open because its trigger was
   pressed, and a trigger outside the shot has already let it go.

   And the rails the panels stand in, edges and resize handles included:
   widening one is adjusting the shot's tools, not leaving it. The split between
   two pages (`.is-gap`) is the document's. */
const FRAME_SHELL =
  ".nt-canvas-shot, .nt-lyr, .nt-style-panel, .nt-toolbar, .nt-mention-anchor, .nt-sb-full, .nt-menu, " +
  ".nt-rail-slot, .nt-resize:not(.is-gap)";

/* The same idea for a place card: a press inside the card or its panel — or a
   menu one of them opened — is still about that card, and anywhere else is
   done with it. */
const LOCATION_SHELL = ".nt-loc, .nt-style-panel, .nt-menu";

/**
 * Where the shell has the pointer's attention — the diagram holding the
 * selection or a held storyboard shot, a chosen place card, or neither. A focus
 * stop on the workspace timeline, so undo re-traces the way the user moved
 * between surfaces (Figma's model).
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
  const [cornerSlot, setCornerSlot] = useState<HTMLElement | null>(null);
  const [finding, setFinding] = useState(false);
  const find = () => setFinding(true);
  const [showingKeys, setShowingKeys] = useState(false);

  const [frame, setFrame] = useState<ActiveFrame | null>(null);
  const [place, setPlace] = useState<ActiveLocation | null>(null);

  // ---- The workspace history spine ---------------------------------------
  // Where attention is, is focus history (a stop on the timeline), and the
  // spine's steps can lead to other pages — so the workspace supplies both
  // the recording wrappers around its own setters and the navigator.
  const spine = useWorkspaceHistory();
  const pageRef = useRef<string | null>(null);
  const openRef = useRef(open);
  const frameRef = useRef(frame);
  const placeRef = useRef(place);
  useEffect(() => {
    openRef.current = open;
    frameRef.current = frame;
    placeRef.current = place;
  });

  // The diagrams on the page: one tool for all of them, and which one holds
  // the selection — what the panels and the bar speak for.
  const hub = useMemo(
    () =>
      createPageCanvasHub(
        spine ? { batch: spine.batch, quiet: spine.walking } : { batch: (fn) => fn() },
      ),
    [spine],
  );
  const held = useHubSnapshot(hub);
  // A held shot keeps its own keys: the page's tool keys stand down.
  useEffect(() => hub.setFramed(() => frameRef.current !== null), [hub]);

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

  /**
   * The focus last recorded or restored — what the next stop starts from. A
   * restore moves it too, or the stop after an undo would say it left from
   * where the undo left.
   */
  const lastFocus = useRef<WorkspaceFocus>({ kind: "none" });
  const applyFocus = useCallback((state: WorkspaceFocus) => {
    lastFocus.current = state;
    if (state.kind === "none") {
      frameRef.current = null;
      setFrame(null);
      setPlace(null);
      return;
    }
    if (state.pageId && pageRef.current !== state.pageId) {
      openRef.current(state.pageId as Id<"pages">);
    }
    // The block brings itself back once it is mounted — after the navigation
    // above, when the restore crossed a page.
    void awaitSurface(state.blockId).then((restore) => restore?.());
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

  /**
   * One focus stop per move of attention, whoever moved it: a selection
   * arriving in another diagram, a shot taken, a place card chosen. A held
   * shot outranks the page's diagrams, and a diagram outranks a place card.
   * Never while history is walking — a step putting a selection back is
   * history's own move, not one to record.
   */
  const hubFocus = useRef<string | null>(null);
  const noteFocus = useCallback(() => {
    const canvasKey = frameRef.current?.key ?? hubFocus.current;
    const next: WorkspaceFocus = canvasKey
      ? { kind: "canvas", pageId: pageRef.current, blockId: canvasKey }
      : placeRef.current
        ? { kind: "place", pageId: pageRef.current, blockId: placeRef.current.blockId }
        : { kind: "none" };
    const before = lastFocus.current;
    lastFocus.current = next;
    const domain = focusDomainRef.current;
    if (domain && focusKey(before) !== focusKey(next) && !spine?.walking()) {
      domain.record(before, next);
    }
  }, [spine]);

  /**
   * Taking a shot lets the page's selection go. A shape or text armed on the
   * page's bar goes with the press into the shot, which draws it — the shot
   * reads its tool at the press, after this has run in the press's capture.
   * Any other tool is put down: the shot has its own, and the page's would
   * still be in hand when the shot let go.
   */
  const claimFrame = useCallback(
    (next: ActiveFrame | null) => {
      const arriving = next !== null && next.key !== frameRef.current?.key;
      frameRef.current = next;
      if (arriving) {
        hub.clearAll();
        const tool = hub.tools?.get();
        if (tool && (SHAPES.has(tool) || tool === "text")) {
          next.api.setTool(tool);
          hub.tools?.settle();
        } else if (tool && tool !== "move") {
          hub.tools?.set("move");
        }
      }
      noteFocus();
      setFrame(next);
    },
    [hub, noteFocus],
  );
  const claimPlace = useCallback(
    (next: ActiveLocation | null) => {
      placeRef.current = next;
      noteFocus();
      setPlace(next);
    },
    [noteFocus],
  );

  // A selection arriving on the page lets a held shot go.
  useEffect(
    () =>
      hub.subscribe(() => {
        hubFocus.current = hub.getSnapshot().focused?.blockId ?? null;
        if (hubFocus.current && frameRef.current) {
          frameRef.current = null;
          setFrame(null);
        }
        noteFocus();
      }),
    [hub, noteFocus],
  );

  const frameClaim = useMemo(() => ({ frame, claim: claimFrame }), [frame, claimFrame]);
  const placeShell = useMemo(
    () => ({ active: place, set: claimPlace }),
    [place, claimPlace],
  );

  const compact = useMediaQuery(COMPACT);
  useRepoNaming(projectId);
  // ⌘= ⌘- ⌘0 zoom the pane with the keyboard, ahead of the page's keys and
  // the browser's own zoom.
  useZoomKeys(() => focus);

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
        // `isContentEditable` rather than an editable ancestor: a diagram's
        // band sits inside the editor but is nobody's text.
        if (el?.isContentEditable || el?.closest?.("input, textarea, select, math-field, [role='dialog']")) return;
        e.preventDefault();
        setShowingKeys(true);
        return;
      }
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const typing = (e.target as HTMLElement | null)?.isContentEditable;
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
  // A selection in a diagram — or a held shot — turns both rails over to it,
  // collapsed or not, but only where there is room for them. The diagram is
  // fully editable without the panels.
  const focusedPage = held.pane ? hub.pane(held.pane) : null;
  const focusedApi = held.focused ? (focusedPage?.get(held.focused.blockId)?.api ?? null) : null;
  const panelTarget = frame
    ? { id: frame.key, api: frame.api, page: null, blockId: undefined }
    : focusedApi && held.focused
      ? {
          id: `${held.pane}:${held.focused.blockId}`,
          api: focusedApi,
          page: focusedPage,
          blockId: held.focused.blockId,
        }
      : null;
  const canvasPanels = compact ? null : panelTarget;
  // A selected place card takes the right rail the same way, and yields to a
  // diagram: editing one is a whole mode, choosing what a card shows is not.
  const placePanel = compact || panelTarget ? null : place;

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

  const holdingFrame = frame !== null;
  useEffect(() => {
    if (!holdingFrame) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(FRAME_SHELL)) claimFrame(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [holdingFrame, claimFrame]);

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
  // Any resolved role without the pen reads — a commenter and a stand-in
  // included — while still selecting text, which is how a commenter comments.
  const viewer = readsOnly(role);
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
  // The panels a selection brings need the diagram's API to render, and that
  // is gone the moment the selection is; the last one is kept for the way out.
  const [lastCanvas, setLastCanvas] = useState(canvasPanels);
  if (canvasPanels && (canvasPanels.id !== lastCanvas?.id || canvasPanels.api !== lastCanvas.api)) {
    setLastCanvas(canvasPanels);
  }
  const [lastPlace, setLastPlace] = useState(placePanel);
  if (placePanel && placePanel !== lastPlace) setLastPlace(placePanel);

  // A page's own keymap picks and puts down the tool inside it. A key pressed
  // anywhere else — the bar just used, a rail, the body — still does, with
  // ⌥⇧ and a letter, and Escape; and heard last, so any control there that
  // spends the key keeps it.
  useEffect(() => {
    const tools = hub.tools;
    if (viewer || !tools) return;
    const apple = isApplePlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || frameRef.current) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.isContentEditable || el?.closest(".nt-pane, .nt-sb-full, [role='dialog'], input, textarea, select, math-field")) {
        return;
      }
      const id = matchShortcut(e, apple);
      if (id === "edit.deselect") {
        if (tools.get() === "move" && !tools.locked()) return;
        e.preventDefault();
        tools.set("move");
        return;
      }
      if (!id?.startsWith("tool.") || !(e.altKey && e.shiftKey)) return;
      const tool = id.slice(5) as CanvasTool;
      if (tool === "text" && !hub.getSnapshot().focused) return;
      e.preventDefault();
      tools.set(tool);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewer, hub]);

  const pagesOn = showLeft && !canvasPanels;
  const layersOn = !!canvasPanels;
  const leftRail = pagesOn || layersOn;
  const pagesHeld = useLinger(pagesOn, RAIL_MS);
  const layersHeld = useLinger(layersOn, RAIL_MS) && !!lastCanvas;

  const rightClaimed = !!canvasPanels || !!placePanel;
  const chatOn = !viewer && showRight && !rightClaimed;
  const designOn = !!canvasPanels;
  const placeOn = !!placePanel;
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
      onFind={find}
      onShowKeys={() => setShowingKeys(true)}
    />
  );

  const chatAsDrawer = compact && openDrawer === "right";
  const chatProps = {
    width: compact ? DRAWER_W : FILL,
    projectId,
    pageId: effectivePageId,
    onCollapse: () => (compact ? setDrawer(null) : setRightOpen(false)),
    ...(chatAsDrawer ? drawerLayer("right") : {}),
  };
  // Inspector panels replace the rail visually, but must not unmount ChatPanel:
  // its hook owns the BrowserChat and its abort signal. `hidden` keeps it out
  // of both layout and the accessibility tree while a diagram or a place card has
  // the slot (or while the rail is collapsed), without mistaking that for Stop.
  const chatHidden = compact ? !chatAsDrawer : !chatOn && !chatHeld;
  // Mounted the first time it is shown, or once the open has gone idle, and
  // never again unmounted — that would be a Stop.
  const [chatMounted, setChatMounted] = useState(false);
  if (!chatMounted && !chatHidden) setChatMounted(true);
  useEffect(() => {
    if (chatMounted || viewer) return;
    const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 2000));
    const handle = idle(() => setChatMounted(true));
    return () => (window.cancelIdleCallback ?? clearTimeout)(handle as number);
  }, [chatMounted, viewer]);

  return (
    <PageCanvasHubContext value={hub}>
    <FrameClaimContext value={frameClaim}>
      <LocationShellContext value={placeShell}>
     <ReadOnlyContext value={viewer}>
     <CommentAccessContext value={commentAccessFor(role)}>
     <PagesProvider pages={pageRefs}>
     <CompletionContextProvider projectId={projectId}>
     <PanelsProvider value={panels}>
      <div className="nt-shell flex h-screen w-full overflow-hidden">
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
                    key={lastCanvas.id}
                    store={lastCanvas.api.store}
                    selection={lastCanvas.api.selection}
                    page={lastCanvas.page}
                    blockId={lastCanvas.blockId}
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
          {!leftRail && (
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
            {/* The main page's comments button lands here, so it sits by the
                way back to the chat, or in the corner once the chat is out. */}
            <span ref={setCornerSlot} className="contents" />
            {!viewer && !rightRail && (
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
          <CornerSlotContext.Provider value={cornerSlot}>
          {mainPageId ? (
            <PageSurface
              pageId={mainPageId}
              pane="main"
              row={rowFor(mainPageId)}
            />
          ) : sortedPages === undefined ? (
            <PageSkeleton />
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
          </CornerSlotContext.Provider>
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
              {chatMounted && (
                <ChatSlot {...chatProps} hidden={chatHidden} />
              )}
            </div>
          )}
          {designHeld && lastCanvas && (
            <div className="nt-rail-face is-right" data-on={designOn} inert={!designOn} style={railWidth(rightWidth)}>
              <CanvasStylePanel key={lastCanvas.id} api={lastCanvas.api} page={lastCanvas.page} />
            </div>
          )}
          {placeHeld && lastPlace && (
            <div className="nt-rail-face is-right" data-on={placeOn} inert={!placeOn} style={railWidth(rightWidth)}>
              <LocationPanel active={lastPlace} />
            </div>
          )}
        </div>

        {/* One bar, one corner, always there: a writer's page tools, a
            reader's zoom, or a held shot's own. The review is a standing question and stacks
            above the page's bar; a shot's bar has the corner to itself while
            it is held. */}
        {frame ? (
          <FrameToolbar
            key={frame.key}
            store={frame.api.store}
            tools={frame.api.tools}
            focus={frame.api.focus}
            board={frame.api.board}
            onPalette={find}
          />
        ) : (
          <>
            {!viewer && hub.tools ? (
              <PageToolbar
                tools={hub.tools}
                focused={held.focused !== null}
                pane={focus}
                refocus={focusedApi?.focus}
                onPalette={find}
              />
            ) : (
              viewer && <ZoomToolbar pane={focus} />
            )}
            {/* Here rather than under the editor: the changes it answers for
                can span pages, and the agent opens pages on its own. */}
            <ReviewBar />
          </>
        )}

        {openDrawer === "left" ? (
          <LeftDrawer label="Close panel" onClose={() => setDrawer(null)}>
            {sidebar}
          </LeftDrawer>
        ) : openDrawer ? (
          <DrawerScrim label="Close panel" onClose={() => setDrawer(null)} />
        ) : null}

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
        <PmfSurvey />
        <DismissSampler />

        {/* Renders nothing itself — it feeds the surfaces their first-touch
            hints while the seeded project still has lessons left. */}
        <Hints projectId={projectId} pageId={effectivePageId} />
      </div>
     </PanelsProvider>
     </CompletionContextProvider>
     </PagesProvider>
     </CommentAccessContext>
     </ReadOnlyContext>
      </LocationShellContext>
    </FrameClaimContext>
    </PageCanvasHubContext>
  );
}

type ChatProps = ComponentProps<typeof ChatPanel>;

/**
 * The chat's code arrives on its own, so it can fail on its own — a dropped
 * connection, or a chunk a newer deploy removed — and that must leave the
 * workspace standing. A failed chat keeps its place as the empty shell and
 * fetches afresh the next time it is shown: `lazy` remembers a rejection, so
 * a retry is a new `lazy`.
 */
class ChatSlot extends Component<
  ChatProps,
  { Panel: ReturnType<typeof loadChat>; failed: boolean; armed: boolean }
> {
  state = { Panel: loadChat(), failed: false, armed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: ChatProps, state: ChatSlot["state"]) {
    if (!state.failed) return null;
    if (props.hidden) return state.armed ? null : { armed: true };
    return state.armed ? { Panel: loadChat(), failed: false, armed: false } : null;
  }
  componentDidCatch(error: unknown) {
    Sentry.captureException(error, { tags: { feature: "chat-panel" } });
  }
  render() {
    const { Panel, failed } = this.state;
    if (failed) return <ChatShell {...this.props} />;
    return (
      <Suspense fallback={<ChatShell {...this.props} />}>
        <Panel {...this.props} />
      </Suspense>
    );
  }
}

/** The chat's rail, empty, while its code is on the way. */
function ChatShell({
  width,
  hidden,
  className = "",
  style,
}: ChatProps) {
  return (
    <aside
      hidden={hidden}
      style={{ width, ...style }}
      className={`nt-panel nt-rail-r ${hidden ? "hidden" : ""} ${className}`}
      aria-label="Chat"
      aria-busy="true"
    />
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
