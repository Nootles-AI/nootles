"use client";

import { Columns, Minus, Plus } from "@/app/components/Icons";
import { Menu, MenuItem } from "@/app/components/Menu";
import { Tooltip } from "@/app/components/Tooltip";
import { Button } from "../canvas/Toolbar";
import type { BoardApi } from "../canvas/render/CanvasSurface";
import { RATIOS, type Ratio } from "./types";

/**
 * A storyboard's own verbs, in the canvas bar while one of its shots is being
 * drawn in: the frame ratio, another shot, and the column pin. They stand
 * where a diagram's zoom does — a shot is a fixed frame at the size its column
 * gives it, so there is nothing to zoom, and these are what a board has in its
 * place.
 */

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

export function BoardControls({ board }: { board: BoardApi }) {
  return (
    <>
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
    </>
  );
}
