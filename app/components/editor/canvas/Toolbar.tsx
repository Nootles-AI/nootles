"use client";

/**
 * The canvas toolbar — floating over the diagram it serves.
 *
 * It is not inside the block: a canvas block is 600px of a document column, and
 * the panels it belongs with are the window's. So it is a fixed pill that
 * *tracks* the canvas instead, and it stands down while a review is open — two
 * bars asking for the same corner is one bar too many, and the unanswered
 * question outranks the tool palette.
 *
 * It takes the stores rather than values, and the readouts subscribe to the
 * scalars they show rather than to whole viewport or history objects. A pan
 * allocates a fresh `Viewport` every frame but leaves `zoom` alone, so it
 * re-renders nothing here; only an actual zoom change redraws the pill.
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
import {
  isSnapEnabled,
  setSnapEnabled,
  subscribe as subscribeSnap,
} from "./engine/snapping";
import { isGridShown, setGridShown, subscribeGrid } from "./engine/dotGrid";
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
import type { ScreenControl } from "./engine/screen";
import type { BoardApi, ToolControl } from "./render/CanvasSurface";
import { BoardControls } from "../storyboard/BoardControls";
import { useViewportZoom, ZOOM_STEP, type ViewportController } from "./engine/useViewport";
import { absoluteSelectionBounds } from "./scene/geometry";
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

// Exported for the page's bar, which shows a subset of the same tools — one
// drawing of each glyph, however many bars carry it.
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
    tool: "hand",
    id: "tool.hand",
    icon: (
      <svg {...svg}>
        <path d="M9 13V5.5a1.5 1.5 0 0 1 3 0V11m0-.5V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7l-2-3a1.6 1.6 0 0 1 2.6-1.8L9 15" />
      </svg>
    ),
  },
  {
    tool: "zoom",
    id: "tool.zoom",
    icon: (
      <svg {...svg}>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.2-4.2M8.5 11h5M11 8.5v5" />
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
  {
    tool: "pen",
    id: "tool.pen",
    // Smaller than its neighbours on purpose: it is the one solid glyph in a
    // row of outlines, and a filled shape carries more weight at the same size.
    icon: <FountainPen {...svg} width={15} height={15} />,
  },
];

/** The shape tools, drawn as one tool in the bar. */
export const SHAPES: ReadonlySet<CanvasTool> = new Set(["rect", "ellipse", "polygon", "diamond"]);
const SHAPE_TOOLS = TOOLS.filter((t) => SHAPES.has(t.tool));
const LEAD_TOOLS = TOOLS.slice(0, TOOLS.findIndex((t) => SHAPES.has(t.tool)));
const TAIL_TOOLS = TOOLS.filter((t) => !SHAPES.has(t.tool) && !LEAD_TOOLS.includes(t));
/** A storyboard shot's: no hand or zoom, since a shot is a fixed frame with
 *  nothing to pan or zoom into, and no connector — a board's relations are its
 *  shot order, not arrows between drawings. */
const SHOT_LEAD = LEAD_TOOLS.filter((t) => t.tool !== "hand" && t.tool !== "zoom");
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

export function Button({
  label,
  hint,
  pressed,
  disabled,
  shape,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  pressed?: boolean;
  /** One of the four shapes — what the bar's morph folds into their slot. */
  shape?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} hint={hint}>
      <button
        type="button"
        className="nt-toolbar-btn"
        aria-label={label}
        aria-pressed={pressed}
        data-shape={shape || undefined}
        disabled={disabled}
        // The canvas keeps its focus, so the keymap and the clipboard keep working
        // with a tool picked by mouse.
        onPointerDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export interface ToolbarProps {
  store: SceneStore;
  viewport: ViewportController;
  /** Subscribed to rather than passed as a value: see {@link ToolControl}. */
  tools: ToolControl;
  screen: ScreenControl;
  /** Set for the moment it is on its way out, after the diagram was let go. */
  leaving?: boolean;
  /** The storyboard the canvas is a shot of, whose verbs stand in for zoom. */
  board?: BoardApi;
}

export function Toolbar({ store, viewport, tools, screen, leaving, board }: ToolbarProps) {
  const tool = useSyncExternalStore(tools.subscribe, tools.get, tools.get);
  // The scalar, not the whole viewport: `commit()` allocates a fresh object on
  // every pan frame, and this pill only shows the zoom.
  const zoom = useViewportZoom(viewport);
  // One timeline: with the workspace spine present the buttons walk it (the
  // diagram's entries included, in order); without it — the share route, the
  // legacy pipeline — they walk the store's own history as they always did.
  const spine = useWorkspaceHistory();
  const local = useSceneHistory(store);
  const global = useSpineState(spine);
  const { canUndo, canRedo } = spine ? global : local;
  const undo = spine ? () => void spine.undo() : () => void store.undo();
  const redo = spine ? () => void spine.redo() : () => void store.redo();

  // `navigator` does not exist on the server, and a glyph that differed between
  // the two renders would be a hydration mismatch. Read as an external value,
  // which is exactly what the platform is.
  const apple = useSyncExternalStore(neverChanges, isApplePlatform, notApple);

  // The snapper owns the setting; this only mirrors it so the box can redraw.
  // Read from the module rather than mirrored in state: anything else that ever
  // toggles snapping would leave a mirrored copy showing the wrong answer.
  const snap = useSyncExternalStore(subscribeSnap, isSnapEnabled, () => true);
  const grid = useSyncExternalStore(subscribeGrid, isGridShown, () => true);

  // Same reasoning as `tools`/`snap` above: the menu's checkboxes have to
  // redraw when the mode changes, whether that came from this menu, the
  // keyboard, or the browser leaving fullscreen on its own.
  const screenState = useSyncExternalStore(screen.subscribe, screen.get, screen.get);

  // The diagram has the keyboard while this bar is up, so its tools show the
  // bare letter they answer to there.
  const hint = (id: ShortcutId) => shortcutHint(id, apple, id.startsWith("tool.") ? 1 : 0);

  const fit = () => {
    const scene = store.getScene();
    const bounds = scene.nodes.length
      ? absoluteSelectionBounds(
          scene,
          scene.nodes.map((node) => node.id),
        )
      : { x: 0, y: 0, w: scene.w, h: scene.h };
    if (bounds.w > 0 && bounds.h > 0) viewport.zoomToFit(bounds);
  };

  return (
    // Docked to the foot of the page column, centred on it, by CSS alone: the
    // shell publishes the column's edges, and nothing here has to follow a
    // scroll. Never a transform on the dock — see `.nt-toolbar-dock`.
    <div className="nt-toolbar-dock" data-leaving={leaving || undefined} inert={leaving}>
      <div className="nt-toolbar" role="toolbar" aria-label="Canvas">
        <ToolRow
          tool={tool}
          lead={board ? SHOT_LEAD : LEAD_TOOLS}
          tail={board ? SHOT_TAIL : TAIL_TOOLS}
          hint={hint}
          onTool={(next) => tools.set(next)}
          // Back to the canvas rather than to the caret, so the next key is a
          // shortcut and the next press draws.
          onPicked={() => viewport.containerRef.current?.focus({ preventScroll: true })}
        />

        <span className="nt-toolbar-sep" aria-hidden />

        <Button
          label="Undo"
          hint={hint("edit.undo")}
          disabled={!canUndo}
          onClick={undo}
        >
          {UNDO}
        </Button>
        <Button
          label="Redo"
          hint={hint("edit.redo")}
          disabled={!canRedo}
          onClick={redo}
        >
          {REDO}
        </Button>

        <span className="nt-toolbar-sep" aria-hidden />

        {board ? (
          <BoardControls board={board} />
        ) : (
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
                  onPointerDown={(e) => e.preventDefault()}
                >
                  {Math.round(zoom * 100)}%
                </button>
              </Tooltip>
            )}
          >
            {(close) => {
              const item = (id: ShortcutId, fn: () => void) => (
                <MenuItem
                  onClick={() => {
                    fn();
                    close();
                  }}
                >
                  {SHORTCUTS_BY_ID[id].label}
                  <span className="ml-auto pl-4 font-mono text-[11px] text-[var(--muted)]">
                    {hint(id)}
                  </span>
                </MenuItem>
              );
              // Unlike `item` above, always closes — stage/minimal/fullscreen
              // each move or hide the trigger this menu is anchored to (a
              // resized stage, an unmounted toolbar), so there is no position
              // left to leave the menu open over. `restoreFocus: false`: the
              // screen host is what lands focus here (the viewport, on stage
              // entry), and the menu's own default restore-to-trigger would
              // fight that the moment the trigger itself moved or vanished.
              const toggle = (id: ShortcutId, checked: boolean, fn: () => void) => (
                <MenuItem
                  onClick={() => {
                    fn();
                    close({ restoreFocus: false });
                  }}
                >
                  <span
                    aria-hidden
                    className={`flex size-3.5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border transition-colors ${
                      checked
                        ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
                        : "border-[var(--border-strong)]"
                    }`}
                  >
                    {checked && <Check width={10} height={10} />}
                  </span>
                  {SHORTCUTS_BY_ID[id].label}
                  <span className="sr-only">{checked ? "On" : "Off"}</span>
                  <span className="ml-auto pl-4 font-mono text-[11px] text-[var(--muted)]">
                    {hint(id)}
                  </span>
                </MenuItem>
              );
              return (
                <>
                  {item("view.zoomIn", () => viewport.zoomBy(ZOOM_STEP))}
                  {item("view.zoomOut", () => viewport.zoomBy(1 / ZOOM_STEP))}
                  {item("view.zoomReset", viewport.resetZoom)}
                  {item("view.zoomFit", fit)}
                  <div className="nt-menu-sep" aria-hidden />
                  {toggle("view.stage", screenState.stage, () => screen.toggle("stage"))}
                  {toggle("view.minimal", screenState.minimal, () => screen.toggle("minimal"))}
                  {screen.canFullscreen() &&
                    toggle("view.fullscreen", screenState.fullscreen, () =>
                      screen.toggle("fullscreen"),
                    )}
                </>
              );
            }}
          </Menu>
        )}

        <span className="nt-toolbar-sep" aria-hidden />

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
              <ToggleRow on={snap} onToggle={() => setSnapEnabled(!snap)}>
                Snap to guides
              </ToggleRow>
              <ToggleRow on={grid} onToggle={() => setGridShown(!grid)}>
                Dot grid
              </ToggleRow>
            </>
          )}
        </Menu>
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
  children,
}: {
  on: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <MenuItem onClick={onToggle}>
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
 * A bar's tools: the ones it offers, the four shapes between them, and the one
 * ink mark that travels to the tool in hand. The canvas's bar folds the shapes
 * into one Figma-style slot to make room for its other tools; the page's bar,
 * with room to spare, lays them out loose. Both bars are this.
 */
export function ToolRow({
  tool,
  lead,
  tail,
  hint,
  onTool,
  onPicked,
  grouped = true,
}: {
  tool: CanvasTool;
  lead: readonly ToolDef[];
  tail: readonly ToolDef[];
  /** The shapes as one slot with a list, or as four buttons of their own. */
  grouped?: boolean;
  hint: (id: ShortcutId) => string;
  onTool: (tool: CanvasTool) => void;
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
      shape={SHAPES.has(id)}
      onClick={() => onTool(id)}
    >
      {icon}
    </Button>
  );

  return (
    <div ref={row} className="nt-toolbar-tools">
      <span className="nt-toolbar-mark" aria-hidden />
      {lead.map(toolButton)}
      {!grouped && SHAPE_TOOLS.map(toolButton)}

      {grouped && (
        /* The four shapes are one tool with four heads, as in Figma: the button
           is whichever was used last, and the caret — or a right click on the
           button — lists all four. Their keys still pick any one directly. */
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
      )}

      {tail.map(toolButton)}
    </div>
  );
}
