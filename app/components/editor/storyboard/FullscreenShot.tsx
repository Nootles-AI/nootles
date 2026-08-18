"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { X } from "@/app/components/Icons";
import {
  CanvasSurface,
  type BoardApi,
  type CanvasApi,
} from "../canvas/render/CanvasSurface";
import { StoryboardToolbar } from "./StoryboardToolbar";
import { SHOT_W } from "./types";

/**
 * One shot, full size — the board's lightbox, except the picture is a canvas.
 *
 * It is the same shot, not a copy: the surface here edits the very scene the
 * tile behind holds, through the same `setShot`, so every stroke lands in both
 * at once. What is its own is the shell claim (`${blockId}:fs${i}`) and the
 * api it publishes — the tile keeps a live canvas of the same index, and two
 * surfaces answering for one entry in the board's map would fight.
 *
 * Portalled to the body, as the album's lightbox is: a fixed overlay inside
 * the editor's stacking contexts is an overlay that isn't.
 *
 * Read-only, it is the same lightbox with the pen taken away: the picture is
 * the whole point of opening a shot, and looking at one closely is not an
 * edit. What goes is the toolbar and the claim on the shell — there are no
 * tools to speak for.
 */
export function FullscreenShot({
  scene,
  frameH,
  board,
  readOnly = false,
  onScene,
  onClaim,
  onClose,
}: {
  scene: string;
  frameH: number;
  board: BoardApi;
  readOnly?: boolean;
  onScene: (scene: string) => void;
  /** Hands the shell this view's claim; re-called as the api changes. */
  onClaim: (api: CanvasApi) => void;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit, never fill: the frame keeps its ratio whatever the window's, so a
  // 9:16 shot stands tall in the middle instead of being stretched to it.
  const scale = box ? Math.min(box.w / SHOT_W, box.h / frameH) : 0;
  const frame = useMemo(() => ({ w: SHOT_W, h: frameH, scale }), [frameH, scale]);

  const [api, setApi] = useState<CanvasApi | null>(null);
  useEffect(() => {
    if (api && !readOnly) onClaim(api);
  }, [api, readOnly, onClaim]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The canvas keymap takes the Escapes that mean something inside it —
      // deselect, leave a tool — and marks them; one that reaches here plain
      // has nothing left to do but close.
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Only a press on the wash itself: the canvas and the bar keep theirs. */
  const onBackdrop = (event: ReactPointerEvent) => {
    if (event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div className="nt-sb-full" onPointerDown={onBackdrop}>
      <button
        type="button"
        className="nt-sb-full-close"
        aria-label="Close"
        onClick={onClose}
      >
        <X />
      </button>
      <div ref={stage} className="nt-sb-full-stage" onPointerDown={onBackdrop}>
        {scale > 0 && (
          <CanvasSurface
            source={scene}
            onChange={onScene}
            readOnly={readOnly}
            frame={frame}
            onApi={setApi}
          />
        )}
      </div>
      {api && !readOnly && (
        <div className="nt-sb-bar-h">
          <StoryboardToolbar api={api} board={board} />
        </div>
      )}
    </div>,
    document.body,
  );
}
