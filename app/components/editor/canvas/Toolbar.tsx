"use client";

/**
 * The canvas toolbar — at the foot of the window, not inside the block.
 *
 * A canvas block is 600px of a document column; a toolbar drawn inside one
 * would sit on top of the diagram it is meant to serve. So it lives where the
 * review bar lives, speaks for whichever canvas is being edited, and stands
 * down while a review is open — two bars asking for the same corner is one
 * bar too many, and the unanswered question outranks the tool palette.
 *
 * It takes the stores rather than values: the zoom readout and the undo state
 * subscribe here, so a pan re-renders this pill and nothing else.
 */

import { useSyncExternalStore, type ReactNode } from "react";
import { Check, FountainPen } from "@/app/components/Icons";
import { Menu, MenuItem } from "@/app/components/Menu";
import { Tooltip } from "@/app/components/Tooltip";
import { isSnapEnabled, setSnapEnabled, subscribe as subscribeSnap } from "./engine/snapping";
import { useSceneHistory, type SceneStore } from "./engine/useScene";
import {
  SHORTCUTS_BY_ID,
  isApplePlatform,
  shortcutHint,
  type CanvasTool,
  type ShortcutId,
} from "./engine/shortcuts";
import {
  useViewportValue,
  type ViewportController,
} from "./engine/useViewport";
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

const TOOLS: readonly { tool: CanvasTool; id: ShortcutId; icon: ReactNode }[] = [
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
    tool: "hand",
    id: "tool.hand",
    icon: (
      <svg {...svg}>
        <path d="M9 13V5.5a1.5 1.5 0 0 1 3 0V11m0-.5V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7l-2-3a1.6 1.6 0 0 1 2.6-1.8L9 15" />
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
];

const UNDO = (
  <svg {...svg}>
    <path d="M4 8h9a5 5 0 0 1 0 10H8M4 8l4-4M4 8l4 4" />
  </svg>
);

const REDO = (
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

const ZOOM_STEP = 1.25;

const neverChanges = () => () => {};
const notApple = () => false;

function Button({
  label,
  hint,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} hint={hint}>
      <button
        type="button"
        className="ab-toolbar-btn"
        aria-label={label}
        aria-pressed={pressed}
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
  tool: CanvasTool;
  onTool: (tool: CanvasTool) => void;
}

export function Toolbar({ store, viewport, tool, onTool }: ToolbarProps) {
  const { zoom } = useViewportValue(viewport);
  const { canUndo, canRedo } = useSceneHistory(store);

  // `navigator` does not exist on the server, and a glyph that differed between
  // the two renders would be a hydration mismatch. Read as an external value,
  // which is exactly what the platform is.
  const apple = useSyncExternalStore(neverChanges, isApplePlatform, notApple);

  // The snapper owns the setting; this only mirrors it so the box can redraw.
  // Read from the module rather than mirrored in state: anything else that ever
  // toggles snapping would leave a mirrored copy showing the wrong answer.
  const snap = useSyncExternalStore(subscribeSnap, isSnapEnabled, () => true);

  const hint = (id: ShortcutId) => shortcutHint(id, apple);

  const fit = () => {
    const scene = store.getScene();
    const bounds = scene.nodes.length
      ? absoluteSelectionBounds(scene, scene.nodes.map((node) => node.id))
      : { x: 0, y: 0, w: scene.w, h: scene.h };
    if (bounds.w > 0 && bounds.h > 0) viewport.zoomToFit(bounds);
  };

  return (
    <div className="ab-toolbar" role="toolbar" aria-label="Canvas">
      {TOOLS.map(({ tool: id, id: shortcut, icon }) => (
        <Button
          key={id}
          label={SHORTCUTS_BY_ID[shortcut].label}
          hint={hint(shortcut)}
          pressed={tool === id}
          onClick={() => onTool(id)}
        >
          {icon}
        </Button>
      ))}

      <span className="ab-toolbar-sep" aria-hidden />

      <Button
        label="Undo"
        hint={hint("edit.undo")}
        disabled={!canUndo}
        onClick={store.undo}
      >
        {UNDO}
      </Button>
      <Button
        label="Redo"
        hint={hint("edit.redo")}
        disabled={!canRedo}
        onClick={store.redo}
      >
        {REDO}
      </Button>

      <span className="ab-toolbar-sep" aria-hidden />

      <Menu
        label="Zoom"
        side="top"
        align="end"
        trigger={(props) => (
          <Tooltip label="Zoom">
            <button
              type="button"
              {...props}
              className="ab-toolbar-zoom"
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
          return (
            <>
              {item("view.zoomIn", () => viewport.zoomBy(ZOOM_STEP))}
              {item("view.zoomOut", () => viewport.zoomBy(1 / ZOOM_STEP))}
              {item("view.zoomReset", viewport.resetZoom)}
              {item("view.zoomFit", fit)}
            </>
          );
        }}
      </Menu>

      <span className="ab-toolbar-sep" aria-hidden />

      <Menu
        label="Canvas settings"
        side="top"
        align="end"
        trigger={(props) => (
          <Tooltip label="Settings">
            <button
              type="button"
              {...props}
              className="ab-toolbar-btn"
              aria-label="Settings"
              onPointerDown={(e) => e.preventDefault()}
            >
              {GEAR}
            </button>
          </Tooltip>
        )}
      >
        {/* Left open on click: a toggle you cannot watch flip is a toggle you
            have to reopen the menu to read. The box is drawn in both states and
            always occupies the same square, so the row neither goes blank when
            snapping is off nor changes width as it flips. */}
        {() => (
          <MenuItem onClick={() => setSnapEnabled(!snap)}>
            <span
              aria-hidden
              className={`flex size-3.5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border transition-colors ${
                snap
                  ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
                  : "border-[var(--border-strong)]"
              }`}
            >
              {snap && <Check width={10} height={10} />}
            </span>
            Snap to guides
            {/* The state a screen reader gets, since `MenuItem` is a plain
                menuitem rather than a menuitemcheckbox. */}
            <span className="sr-only">{snap ? "On" : "Off"}</span>
          </MenuItem>
        )}
      </Menu>
    </div>
  );
}
