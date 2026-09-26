"use client";

/**
 * The bar at the foot of the page column.
 *
 * One bar, always there: the page's tools are the diagrams' tools, since a
 * shape can be drawn onto the page as readily as into a diagram already on it.
 * A storyboard shot, a fixed frame with tools and keys of its own, brings its
 * own bar while it is held. Both take stores rather than values and subscribe
 * to the scalars they show.
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Check, FountainPen } from "@/app/components/Icons";
import { Menu, MenuItem } from "@/app/components/Menu";
import { Tooltip } from "@/app/components/Tooltip";
import { useColumnEdges } from "@/app/lib/columnEdges";
import { stepZoom, zoomFor, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS, type ZoomPane } from "@/app/lib/docZoom";
import { useAutocomplete } from "../ai/useAutocomplete";
import { ReachPopover, SPARK_PATH as SPARK } from "../ai/ReachSlider";
import {
  getSnapTargets,
  isSnapEnabled,
  setSnapEnabled,
  setSnapTarget,
  subscribe as subscribeSnap,
  type SnapTargetKind,
} from "./engine/snapping";
import { isGridShown, setGridShown, subscribeGrid } from "./engine/dotGrid";
import type { WorkspaceHistory } from "@/app/lib/history/spine";
import {
  useSpineState,
  useWorkspaceHistory,
} from "@/app/lib/history/useWorkspaceHistory";
import { useSceneHistory, type SceneStore } from "./engine/useScene";
import {
  SHORTCUTS_BY_ID,
  isApplePlatform,
  shortcutHint,
  type CanvasTool,
  type ShortcutId,
} from "./engine/shortcuts";
import type { BoardApi, ToolControl } from "./render/CanvasSurface";
import type { PageToolControl } from "./page/tools";
import { BoardControls } from "../storyboard/BoardControls";
import "./canvas.css";

const svg = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// No hand: it is a key and the space bar, never a button — the page scrolls.
export const TOOLS: readonly { tool: CanvasTool; id: ShortcutId; icon: ReactNode }[] = [
  {
    tool: "move",
    id: "tool.move",
    icon: (
      <svg {...svg}>
        <path d="M5 3.5 18 12l-5.6 1.2L9.8 19z" />
      </svg>
    ),
  },
  {
    tool: "scale",
    id: "tool.scale",
    // The move tool's arrow with a corner pulling away from it: the gesture the
    // tool is, rather than a pair of arrows that would read as a resize.
    icon: (
      <svg {...svg}>
        <path d="M4 3.2 14.5 10l-4.5 1-2.1 4.6z" />
        <path d="M14 20h6v-6M20 20l-5.5-5.5" />
      </svg>
    ),
  },
  {
    tool: "rect",
    id: "tool.rect",
    icon: (
      <svg {...svg}>
        <rect x="3.5" y="6" width="17" height="12" rx="2" />
      </svg>
    ),
  },
  {
    tool: "ellipse",
    id: "tool.ellipse",
    icon: (
      <svg {...svg}>
        <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
      </svg>
    ),
  },
  {
    tool: "polygon",
    id: "tool.polygon",
    icon: (
      <svg {...svg}>
        <path d="M12 4.6 20.6 19.4H3.4z" />
      </svg>
    ),
  },
  {
    tool: "diamond",
    id: "tool.diamond",
    icon: (
      <svg {...svg}>
        <path d="M12 3.8 20.2 12 12 20.2 3.8 12z" />
      </svg>
    ),
  },
  {
    tool: "text",
    id: "tool.text",
    icon: (
      <svg {...svg}>
        <path d="M5 6h14M12 6v12M9 18h6" />
      </svg>
    ),
  },
  {
    tool: "pen",
    id: "tool.pen",
    // Smaller than its neighbours on purpose: it is the one solid glyph in a
    // row of outlines, and a filled shape carries more weight at the same size.
    icon: <FountainPen {...svg} width={15} height={15} />,
  },
  {
    tool: "connector",
    id: "tool.connector",
    // An elbow with a plug at each end: the shape the tool actually draws.
    icon: (
      <svg {...svg}>
        <path d="M7 6h6a3 3 0 0 1 3 3v6" />
        <circle cx="4.5" cy="6" r="2" />
        <circle cx="16" cy="18.5" r="2" />
      </svg>
    ),
  },
];

/** The shape tools, drawn as one tool in the bar. */
export const SHAPES: ReadonlySet<CanvasTool> = new Set(["rect", "ellipse", "polygon", "diamond"]);
const SHAPE_TOOLS = TOOLS.filter((t) => SHAPES.has(t.tool));
const LEAD_TOOLS = TOOLS.slice(0, TOOLS.findIndex((t) => SHAPES.has(t.tool)));
const TAIL_TOOLS = TOOLS.filter((t) => !SHAPES.has(t.tool) && !LEAD_TOOLS.includes(t));
/** A storyboard shot's: no connector — a board's relations are its shot
 *  order, not arrows between drawings. */
const SHOT_TAIL = TAIL_TOOLS.filter((t) => t.tool !== "connector");

/** The slot's disclosure: a small chevron, as Figma draws it. */
const CARET = (
  <svg width={8} height={8} viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 3.25 4 5.25l2-2" />
  </svg>
);


export const UNDO = (
  <svg {...svg}>
    <path d="M4 8h9a5 5 0 0 1 0 10H8M4 8l4-4M4 8l4 4" />
  </svg>
);

export const REDO = (
  <svg {...svg}>
    <path d="M20 8h-9a5 5 0 0 0 0 10h5M20 8l-4-4M20 8l-4 4" />
  </svg>
);

const GEAR = (
  <svg {...svg}>
    <path d="M18.1 10.1h2.7v3.6h-2.7a6.4 6.4 0 0 1-1.4 2.5l1.2 2.4-3 1.7-1.5-2.3a6.4 6.4 0 0 1-2.8 0l-1.5 2.3-3-1.7 1.2-2.4a6.4 6.4 0 0 1-1.4-2.5H3.2v-3.6h2.7a6.4 6.4 0 0 1 1.4-2.5L6.1 5.2l3-1.7 1.5 2.3a6.4 6.4 0 0 1 2.8 0l1.5-2.3 3 1.7-1.2 2.4a6.4 6.4 0 0 1 1.4 2.5Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

const neverChanges = () => () => {};
const notApple = () => false;

/** `navigator` does not exist on the server; read as the external value it is. */
const useApple = () => useSyncExternalStore(neverChanges, isApplePlatform, notApple);

export function Button({
  label,
  hint,
  pressed,
  toggle,
  locked,
  disabled,
  onClick,
  onDoubleClick,
  onContextMenu,
  children,
}: {
  label: string;
  hint: string;
  pressed?: boolean;
  /**
   * A standing setting rather than a tool in hand: `pressed` is announced but
   * not inked, since a setting that is usually on would otherwise read as a
   * tool left armed. The icon says which way it stands.
   */
  toggle?: boolean;
  /** A tool kept in hand past one use: a dot under it, in ink, never the accent. */
  locked?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  /** A button with more to it than its click: the rest, on a right-click. */
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} hint={hint}>
      <button
        type="button"
        className="nt-toolbar-btn"
        aria-label={label}
        aria-pressed={pressed}
        data-toggle={toggle || undefined}
        data-locked={locked || undefined}
        disabled={disabled}
        // The canvas keeps its focus, so the keymap and the clipboard keep working
        // with a tool picked by mouse.
        onPointerDown={(e) => e.preventDefault()}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** ⌘, as Lucide draws it: the palette's key, and so its button. */
const COMMAND = (
  <svg {...svg}>
    <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
  </svg>
);

/**
 * The workspace's palette — pages, rails, the keys — from the bar, for
 * whoever reaches for the mouse rather than ⌘K. The bar's last word, after a
 * rule of its own: it is not a tool and does nothing to the drawing.
 */
function PaletteButton({ apple, onOpen }: { apple: boolean; onOpen: () => void }) {
  return (
    <>
      <span className="nt-toolbar-sep" aria-hidden />
      <Button label="Command palette" hint={apple ? "⌘K" : "Ctrl+K"} onClick={onOpen}>
        {COMMAND}
      </Button>
    </>
  );
}

const AUTOCOMPLETE_ON = (
  <svg {...svg}>
    <path d={SPARK} />
  </svg>
);
const AUTOCOMPLETE_OFF = (
  <svg {...svg}>
    <path d={SPARK} />
    <path d="M4 4l16 16" />
  </svg>
);

/** The account's autocomplete, a switch on the bar; its reach on a right-click. */
function AutocompleteButton() {
  const autocomplete = useAutocomplete();
  /** Where the switch was when a right-click asked for its reach. */
  const [reachAt, setReachAt] = useState<DOMRect | null>(null);
  if (!autocomplete.loaded) return null;
  return (
    <>
      <span className="nt-toolbar-sep" aria-hidden />
      <Button
        label="Autocomplete"
        hint={autocomplete.on ? "On" : "Off"}
        pressed={autocomplete.on}
        toggle
        onClick={() => autocomplete.setOn(!autocomplete.on)}
        onContextMenu={(e) => {
          e.preventDefault();
          setReachAt(e.currentTarget.getBoundingClientRect());
        }}
      >
        {autocomplete.on ? AUTOCOMPLETE_ON : AUTOCOMPLETE_OFF}
      </Button>
      {reachAt && <ReachPopover anchor={reachAt} onClose={() => setReachAt(null)} />}
    </>
  );
}

/**
 * Undo and redo. One timeline: with the workspace spine present the buttons
 * walk it, the diagrams' entries included, in order; without it — the share
 * route, the legacy pipeline — a surface's buttons walk its store's own history.
 */
function History({ store, hint }: { store?: SceneStore; hint: (id: ShortcutId) => string }) {
  const spine = useWorkspaceHistory();
  if (spine) return <SpineHistory spine={spine} hint={hint} />;
  return store ? <StoreHistory store={store} hint={hint} /> : null;
}

function SpineHistory({ spine, hint }: { spine: WorkspaceHistory; hint: (id: ShortcutId) => string }) {
  const { canUndo, canRedo } = useSpineState(spine);
  return (
    <UndoRedo
      hint={hint}
      canUndo={canUndo}
      canRedo={canRedo}
      undo={() => void spine.undo()}
      redo={() => void spine.redo()}
    />
  );
}

function StoreHistory({ store, hint }: { store: SceneStore; hint: (id: ShortcutId) => string }) {
  const { canUndo, canRedo } = useSceneHistory(store);
  return (
    <UndoRedo
      hint={hint}
      canUndo={canUndo}
      canRedo={canRedo}
      undo={() => void store.undo()}
      redo={() => void store.redo()}
    />
  );
}

function UndoRedo({
  hint,
  canUndo,
  canRedo,
  undo,
  redo,
}: {
  hint: (id: ShortcutId) => string;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}) {
  return (
    <>
      <span className="nt-toolbar-sep" aria-hidden />
      <Button label="Undo" hint={hint("edit.undo")} disabled={!canUndo} onClick={undo}>
        {UNDO}
      </Button>
      <Button label="Redo" hint={hint("edit.redo")} disabled={!canRedo} onClick={redo}>
        {REDO}
      </Button>
    </>
  );
}

/** What a gesture on the page may snap to, beneath the master switch. */
const SNAP_TARGETS: readonly { kind: SnapTargetKind; label: string }[] = [
  { kind: "shapes", label: "Shapes" },
  { kind: "column", label: "Text column" },
  { kind: "diagrams", label: "Other diagrams" },
];

/**
 * Snapping and the dot grid: the snapper and the grid own them; this mirrors.
 * On the page, snapping also says what to: a shot has no column and no other
 * diagrams to line up with.
 */
function Settings({ targets = false }: { targets?: boolean }) {
  const snap = useSyncExternalStore(subscribeSnap, isSnapEnabled, () => true);
  const on = useSyncExternalStore(subscribeSnap, getSnapTargets, getSnapTargets);
  const grid = useSyncExternalStore(subscribeGrid, isGridShown, () => true);
  return (
    <Menu
      label="Canvas settings"
      side="top"
      align="end"
      trigger={(props) => (
        <Tooltip label="Settings">
          <button
            type="button"
            {...props}
            className="nt-toolbar-btn"
            aria-label="Settings"
            onPointerDown={(e) => e.preventDefault()}
          >
            {GEAR}
          </button>
        </Tooltip>
      )}
    >
      {/* Left open on click: a toggle you cannot watch flip is a toggle you
        have to reopen the menu to read. */}
      {() => (
        <>
          <ToggleRow on={grid} onToggle={() => setGridShown(!grid)}>
            Dot grid
          </ToggleRow>
          <ToggleRow on={snap} onToggle={() => setSnapEnabled(!snap)}>
            Snap to guides
          </ToggleRow>
          {targets &&
            SNAP_TARGETS.map(({ kind, label }) => (
              <ToggleRow
                key={kind}
                on={on[kind]}
                disabled={!snap}
                inset
                onToggle={() => setSnapTarget(kind, !on[kind])}
              >
                {label}
              </ToggleRow>
            ))}
        </>
      )}
    </Menu>
  );
}

const unzoomed = () => 1;
const percent = (z: number) => `${Math.round(z * 100)}%`;

/**
 * The focused page's zoom: its readout, and a menu of the steps. The zoom is
 * the page's, not the diagrams' — a diagram is magnified with the words
 * around it.
 */
function ZoomMenu({ pane, hint }: { pane: ZoomPane; hint: (id: ShortcutId) => string }) {
  const store = zoomFor(pane);
  const zoom = useSyncExternalStore(store.subscribe, store.get, unzoomed);
  return (
    <Menu
      label="Zoom"
      side="top"
      align="end"
      trigger={(props) => (
        <Tooltip label="Zoom">
          <button
            type="button"
            {...props}
            className="nt-toolbar-zoom"
            aria-label={`Zoom ${percent(zoom)}`}
            onPointerDown={(e) => e.preventDefault()}
          >
            {percent(zoom)}
          </button>
        </Tooltip>
      )}
    >
      {(close) => {
        const run = (fn: () => void) => () => {
          fn();
          close();
        };
        const row = (id: ShortcutId, label: string, disabled: boolean, fn: () => void) => (
          <MenuItem onClick={run(fn)} disabled={disabled}>
            {label}
            <kbd className="nt-menu-kbd">{hint(id)}</kbd>
          </MenuItem>
        );
        return (
          <>
            {row("view.zoomIn", SHORTCUTS_BY_ID["view.zoomIn"].label, zoom >= ZOOM_MAX, () =>
              store.set(stepZoom(zoom, 1)),
            )}
            {row("view.zoomOut", SHORTCUTS_BY_ID["view.zoomOut"].label, zoom <= ZOOM_MIN, () =>
              store.set(stepZoom(zoom, -1)),
            )}
            <div className="nt-menu-sep" aria-hidden />
            {ZOOM_STEPS.map((step) => (
              <MenuItem key={step} onClick={run(() => store.set(step))}>
                {percent(step)}
                <Check
                  width={14}
                  height={14}
                  aria-hidden
                  className={`nt-menu-check${Math.abs(step - zoom) < 0.005 ? " is-on" : ""}`}
                />
              </MenuItem>
            ))}
            <div className="nt-menu-sep" aria-hidden />
            {row("view.zoomReset", "Reset zoom", zoom === ZOOM_MIN, store.reset)}
          </>
        );
      }}
    </Menu>
  );
}

/**
 * A reader's bar: nothing to draw with, but the page still zooms — the
 * workspace's viewers and the share route.
 */
export function ZoomToolbar({ pane }: { pane: ZoomPane }) {
  const apple = useApple();
  const dock = useRef<HTMLDivElement>(null);
  useColumnEdges(dock);
  return (
    <div ref={dock} className="nt-toolbar-dock is-page">
      <div className="nt-toolbar" role="toolbar" aria-label="Document zoom">
        <ZoomMenu pane={pane} hint={(id) => shortcutHint(id, apple)} />
      </div>
    </div>
  );
}

/**
 * The page's bar. Its tools are every diagram's: a shape picked here draws on
 * the page, or in whichever diagram the press lands on. Text needs a diagram
 * to be written in, so it waits for one to be focused.
 */
export function PageToolbar({
  tools,
  focused,
  pane,
  refocus,
  onPalette,
}: {
  tools: PageToolControl;
  /** Whether a diagram holds the selection — it has the keyboard, so its keys are bare. */
  focused: boolean;
  /** The pane with the keyboard, whose zoom the bar reads. */
  pane: ZoomPane;
  /** Hands the keyboard back to the focused diagram after a pick from a list. */
  refocus?: () => void;
  onPalette?: () => void;
}) {
  const { tool, locked } = useSyncExternalStore(tools.subscribe, tools.snapshot, tools.snapshot);
  const apple = useApple();
  const dock = useRef<HTMLDivElement>(null);
  useColumnEdges(dock);
  // A diagram with the keyboard answers the bare letter; the page, where a
  // bare letter is typing, answers ⌥⇧ and the letter.
  const hint = (id: ShortcutId) =>
    shortcutHint(id, apple, focused && id.startsWith("tool.") ? 1 : 0);

  return (
    <div ref={dock} className="nt-toolbar-dock is-page">
      <div className="nt-toolbar" role="toolbar" aria-label="Page tools">
        <ToolRow
          tool={tool}
          locked={locked}
          lead={LEAD_TOOLS}
          tail={TAIL_TOOLS}
          disabled={focused ? undefined : NEEDS_A_DIAGRAM}
          hint={hint}
          onTool={tools.set}
          onLock={tools.lock}
          onPicked={refocus}
        />
        <History hint={hint} />
        <span className="nt-toolbar-sep" aria-hidden />
        <ZoomMenu pane={pane} hint={hint} />
        <span className="nt-toolbar-sep" aria-hidden />
        <Settings targets />
        <AutocompleteButton />
        {onPalette && <PaletteButton apple={apple} onOpen={onPalette} />}
      </div>
    </div>
  );
}

const NEEDS_A_DIAGRAM: ReadonlySet<CanvasTool> = new Set(["text"]);

/**
 * A storyboard shot's bar, while the shot is held: the shot's own tools, the
 * board's controls where the page's zoom would be, and the same settings.
 */
export function FrameToolbar({
  store,
  tools,
  board,
  focus,
  onPalette,
}: {
  store: SceneStore;
  /** Subscribed to rather than passed as a value: see {@link ToolControl}. */
  tools: ToolControl;
  board?: BoardApi;
  /** Hands the keyboard back to the shot after a shape is picked from the list. */
  focus?: () => void;
  onPalette?: () => void;
}) {
  const tool = useSyncExternalStore(tools.subscribe, tools.get, tools.get);
  const apple = useApple();
  const dock = useRef<HTMLDivElement>(null);
  useColumnEdges(dock);
  // The shot has the keyboard while this bar is up, so its tools show the
  // bare letter they answer to there.
  const hint = (id: ShortcutId) => shortcutHint(id, apple, id.startsWith("tool.") ? 1 : 0);

  return (
    // Docked to the foot of the page column, centred on it: the dock follows
    // the column's edges, and nothing here has to follow a scroll. Never a
    // transform on the dock — see `.nt-toolbar-dock`.
    <div ref={dock} className="nt-toolbar-dock">
      <div className="nt-toolbar" role="toolbar" aria-label="Canvas">
        <ToolRow
          tool={tool}
          lead={LEAD_TOOLS}
          tail={SHOT_TAIL}
          hint={hint}
          onTool={(next) => tools.set(next)}
          onPicked={focus}
        />
        <History store={store} hint={hint} />
        {board && (
          <>
            <span className="nt-toolbar-sep" aria-hidden />
            <BoardControls board={board} />
          </>
        )}
        <span className="nt-toolbar-sep" aria-hidden />
        <Settings />
        {onPalette && <PaletteButton apple={apple} onOpen={onPalette} />}
      </div>
    </div>
  );
}

/**
 * A setting that is on or off, as a menu row. The box is drawn in both states
 * and always occupies the same square, so the row neither goes blank when the
 * setting is off nor changes width as it flips.
 */
function ToggleRow({
  on,
  onToggle,
  disabled,
  inset,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  /** Its parent setting is off, so it has nothing to decide. */
  disabled?: boolean;
  /** Indented under the setting it refines. */
  inset?: boolean;
  children: ReactNode;
}) {
  return (
    <MenuItem onClick={onToggle} disabled={disabled} className={inset ? "pl-[calc(var(--inset)+22px)]" : undefined}>
      <span
        aria-hidden
        className={`flex size-3.5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border transition-colors ${
          on
            ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
            : "border-[var(--border-strong)]"
        }`}
      >
        {on && <Check width={10} height={10} />}
      </span>
      {children}
      {/* The state a screen reader gets, since `MenuItem` is a plain menuitem
        rather than a menuitemcheckbox. */}
      <span className="sr-only">{on ? "On" : "Off"}</span>
    </MenuItem>
  );
}

type ToolDef = (typeof TOOLS)[number];

/**
 * A bar's tools: the ones it offers, the four shapes folded into one
 * Figma-style slot between them, and the one ink mark that travels to the tool
 * in hand. A double-click keeps a tool in hand past one use; Move is where one
 * use ends, so it never is.
 */
function ToolRow({
  tool,
  locked = false,
  lead,
  tail,
  disabled,
  hint,
  onTool,
  onLock,
  onPicked,
}: {
  tool: CanvasTool;
  locked?: boolean;
  lead: readonly ToolDef[];
  tail: readonly ToolDef[];
  /** Tools on the bar that cannot be picked right now. */
  disabled?: ReadonlySet<CanvasTool>;
  hint: (id: ShortcutId) => string;
  onTool: (tool: CanvasTool) => void;
  /** A double-click: keep this tool in hand. Absent, no tool locks. */
  onLock?: (tool: CanvasTool) => void;
  /** After a shape is chosen from the list — where focus should go next. */
  onPicked?: () => void;
}) {
  // The shape the slot stands for: the one in hand, or else the one last used.
  // Kept as it changes, during render, so it is never a frame behind.
  const [lastShape, setLastShape] = useState<CanvasTool>("rect");
  if (SHAPES.has(tool) && tool !== lastShape) setLastShape(tool);
  const shape = SHAPE_TOOLS.find((t) => t.tool === lastShape) ?? SHAPE_TOOLS[0];

  // The travelling mark goes to whichever button is pressed, placed from its
  // measured box and written to the row as properties: moving a mark is not a
  // render. A tool with no button in the row leaves it hidden where it was.
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const pressed = el.querySelector<HTMLElement>('.nt-toolbar-btn[aria-pressed="true"]');
    // A shape in hand inks the whole slot, caret and all: it is one tool.
    const on = pressed?.closest<HTMLElement>(".nt-toolbar-shapes") ?? pressed;
    el.dataset.marked = String(!!on);
    if (!on) return;
    // Offsets, not rects: the bar arrives scaled, and a rect read in its first
    // frame would be measured at 94%. The row is the positioned parent.
    el.style.setProperty("--mark-x", `${on.offsetLeft}px`);
    el.style.setProperty("--mark-w", `${on.offsetWidth}px`);
    el.style.setProperty("--mark-h", `${on.offsetHeight}px`);
  }, [tool, lastShape]);

  // The caret never takes focus — the canvas or the page keeps the keyboard —
  // so the list it opens focuses its first row by script, which the browser
  // then rings as if a key had done it. A list a pointer opened says so, and
  // shows where the pointer is instead, until a key is actually used in it.
  const byPointer = () =>
    requestAnimationFrame(() => {
      const list = document.querySelector<HTMLElement>('[role="menu"][aria-label="Shapes"]');
      if (!list) return;
      list.dataset.byPointer = "";
      list.addEventListener("keydown", () => delete list.dataset.byPointer, { once: true });
    });

  const toolButton = ({ tool: id, id: shortcut, icon }: ToolDef) => (
    <Button
      key={id}
      label={SHORTCUTS_BY_ID[shortcut].label}
      hint={hint(shortcut)}
      pressed={tool === id}
      locked={locked && tool === id && id !== "move"}
      disabled={disabled?.has(id)}
      onClick={() => onTool(id)}
      onDoubleClick={onLock && id !== "move" ? () => onLock(id) : undefined}
    >
      {icon}
    </Button>
  );

  return (
    <div ref={row} className="nt-toolbar-tools">
      <span className="nt-toolbar-mark" aria-hidden />
      {lead.map(toolButton)}

      {/* The four shapes are one tool with four heads, as in Figma: the button
          is whichever was used last, and the caret — or a right click on the
          button — lists all four. Their keys still pick any one directly. */}
      <span
        className="nt-toolbar-shapes"
        data-on={SHAPES.has(tool) || undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLButtonElement>(".nt-toolbar-caret")?.click();
          byPointer();
        }}
      >
        {toolButton(shape)}
        <Menu
          label="Shapes"
          side="top"
          align="start"
          className="nt-tool-flyout"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              // A click with a `detail` came from a pointer; Enter and Space
              // click with none, and those keep the keyboard ring.
              onClick={(e) => {
                props.onClick();
                if (e.detail > 0) byPointer();
              }}
              aria-label="All shapes"
              className="nt-toolbar-caret"
              onPointerDown={(e) => e.preventDefault()}
            >
              {CARET}
            </button>
          )}
        >
          {(close) =>
            SHAPE_TOOLS.map((t) => (
              <MenuItem
                key={t.tool}
                onClick={() => {
                  onTool(t.tool);
                  close({ restoreFocus: false });
                  onPicked?.();
                }}
              >
                <Check
                  width={12}
                  height={12}
                  strokeWidth={2.5}
                  className="nt-tool-flyout-check"
                  data-on={tool === t.tool || undefined}
                />
                <span className="nt-tool-flyout-icon">{t.icon}</span>
                <span className="nt-tool-flyout-name">{SHORTCUTS_BY_ID[t.id].label}</span>
                <kbd className="nt-tool-flyout-key">{hint(t.id)}</kbd>
              </MenuItem>
            ))
          }
        </Menu>
      </span>

      {tail.map(toolButton)}
    </div>
  );
}
