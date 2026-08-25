"use client";

import { useSyncExternalStore } from "react";
import { Columns, Minus, Plus } from "@/app/components/Icons";
import { Menu, MenuItem } from "@/app/components/Menu";
import { Tooltip } from "@/app/components/Tooltip";
import { Button, REDO, TOOLS, UNDO } from "../canvas/Toolbar";
import {
  SHORTCUTS_BY_ID,
  isApplePlatform,
  shortcutHint,
  type CanvasTool,
} from "../canvas/engine/shortcuts";
import { useSceneHistory } from "../canvas/engine/useScene";
import type { BoardApi, CanvasApi } from "../canvas/render/CanvasSurface";
import { RATIOS, type Ratio } from "./types";

/**
 * The storyboard's own bar — vertical, at the board's right shoulder.
 *
 * Not the canvas pill with different contents: that one floats over the diagram
 * it serves, and a board is the one canvas where floating over the work means
 * standing on it — the pill sat exactly where the bottom row of shots goes.
 * Beside the board, the bar is never over a drawing at any board width.
 *
 * What it drops from the pill is what a shot cannot use. Zoom: a shot is a
 * fixed frame at the size its column gives it — there is nothing to zoom into.
 * The hand: nothing to pan. The connector: a board's relations are its shot
 * order, not arrows between drawings. Undo/redo stay, because they are the
 * active shot's history, and the ratio and add-shot controls are the board's
 * own two verbs.
 */

/** The pill's tools, minus the two a shot has no use for. */
const SHOT_TOOLS = TOOLS.filter(
  ({ tool }) => tool !== "hand" && tool !== "connector",
);

/** Three panels and a plus: another shot. Drawn at the tools' weight. */
const ADD_SHOT = (
  <svg
    width={17}
    height={17}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="2.5" y="6" width="6" height="7" rx="1" />
    <rect x="10.5" y="6" width="6" height="7" rx="1" />
    <path d="M19.5 9.5h4M21.5 7.5v4" />
  </svg>
);

const neverChanges = () => () => {};
const notApple = () => false;

export function StoryboardToolbar({
  api,
  board,
}: {
  /** The active shot's canvas — the bar's tools and history act on this. */
  api: CanvasApi;
  board: BoardApi;
}) {
  const { canUndo, canRedo } = useSceneHistory(api.store);
  // The pressed tool is subscribed to rather than read off the api, which does
  // not change when the tool does — see {@link ToolControl}.
  const active = useSyncExternalStore(
    api.tools.subscribe,
    api.tools.get,
    api.tools.get,
  );
  const apple = useSyncExternalStore(neverChanges, isApplePlatform, notApple);
  const hint = (id: (typeof TOOLS)[number]["id"]) => shortcutHint(id, apple);

  return (
    <div className="nt-toolbar nt-sb-bar" role="toolbar" aria-label="Storyboard">
      {SHOT_TOOLS.map(({ tool, id, icon }) => (
        <Button
          key={tool}
          label={SHORTCUTS_BY_ID[id].label}
          hint={hint(id)}
          pressed={active === (tool as CanvasTool)}
          onClick={() => api.setTool(tool)}
        >
          {icon}
        </Button>
      ))}

      <span className="nt-toolbar-sep" aria-hidden />

      <Button
        label="Undo"
        hint={shortcutHint("edit.undo", apple)}
        disabled={!canUndo}
        onClick={api.store.undo}
      >
        {UNDO}
      </Button>
      <Button
        label="Redo"
        hint={shortcutHint("edit.redo", apple)}
        disabled={!canRedo}
        onClick={api.store.redo}
      >
        {REDO}
      </Button>

      <span className="nt-toolbar-sep" aria-hidden />

      <Menu
        label="Frame ratio"
        side="top"
        align="end"
        trigger={(props) => (
          <Tooltip label="Frame ratio" hint="Re-crops every shot">
            <button
              type="button"
              {...props}
              className="nt-toolbar-zoom nt-sb-ratio"
              onPointerDown={(e) => e.preventDefault()}
            >
              {board.ratio}
            </button>
          </Tooltip>
        )}
      >
        {(close) => (
          <>
            {RATIOS.map((r: { id: Ratio }) => (
              <MenuItem
                key={r.id}
                onClick={() => {
                  board.setRatio(r.id);
                  close();
                }}
              >
                {r.id}
                {r.id === board.ratio ? (
                  <span className="ml-auto pl-4 text-[11px] text-[var(--muted)]">
                    current
                  </span>
                ) : null}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>

      <Button
        label="Add shot"
        hint={`${board.shots} shot${board.shots === 1 ? "" : "s"}`}
        onClick={board.addShot}
      >
        {ADD_SHOT}
      </Button>

      <span className="nt-toolbar-sep" aria-hidden />

      {/* The column pin, the album's control verbatim: fewer / count / more,
          double-click the count to let the width decide again. */}
      <Button
        label="Fewer, bigger"
        hint=""
        disabled={board.cols <= 1}
        onClick={() => board.pin(-1)}
      >
        <Minus width={15} height={15} />
      </Button>
      <Tooltip
        label={
          board.pinned ? "Columns — double-click to let the width decide" : "Columns"
        }
      >
        <button
          type="button"
          className="nt-toolbar-zoom nt-sb-cols"
          aria-label={`${board.cols} columns`}
          aria-pressed={board.pinned}
          onPointerDown={(e) => e.preventDefault()}
          onDoubleClick={board.unpin}
        >
          <Columns width={13} height={13} />
          {board.cols}
        </button>
      </Tooltip>
      <Button
        label="More, smaller"
        hint=""
        disabled={board.cols >= board.most}
        onClick={() => board.pin(1)}
      >
        <Plus width={15} height={15} />
      </Button>
    </div>
  );
}
