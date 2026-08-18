"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { X } from "@/app/components/Icons";
import { CanvasSurface, type CanvasApi } from "../canvas/render/CanvasSurface";
import { useCanvasShell } from "../canvas/shell";
import { FullscreenShot } from "./FullscreenShot";
import { StoryboardToolbar } from "./StoryboardToolbar";
import { parseStoryboard } from "./parse";
import { serializeStoryboard } from "./serialize";
import {
  DEFAULT_SHOTS,
  SHOT_W,
  emptyStoryboard,
  shotHeight,
  type Ratio,
  type Shot,
  type Storyboard,
} from "./types";
import "./storyboard.css";

/**
 * The board itself: a container of shots, laid out in as many columns as the
 * width allows.
 *
 * The container owns the structure and each shot owns a canvas. That split is
 * the whole design — see `types.ts` — and it is what makes this component
 * mostly layout: there is no constraint to enforce, because a drawing has
 * nowhere to go but the shot it is in.
 */

/** Below this a shot is too small to draw in; the column count gives way first. */
const MIN_SHOT_W = 150;
const MAX_COLS = 6;
const GAP = 16;
/** Quiet time before typed notes reach the block. Keystrokes are not writes. */
const NOTE_FLUSH_MS = 400;
/** One column and its chrome — the narrowest a board is worth being. */
const MIN_BOARD_W = 240;
/** Between the board's edge and its bar. */
const BAR_GAP = 12;
/** Keeps the bar off the pane's edge when the board runs it over. */
const BAR_EDGE = 8;

/** Arrows leaving for the corners: the shot at full size. The X's weight. */
const EXPAND = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);

function columnsFor(width: number, shots: number, pinned?: number): number {
  if (width <= 0) return Math.min(DEFAULT_SHOTS, Math.max(1, shots));
  // A pin replaces what the width would decide — the album's contract. It may
  // exceed what fits comfortably (that is what "smaller shots" means) but never
  // the shot count: an empty column is width taken from the shots for nothing.
  const fits = pinned ?? Math.floor((width + GAP) / (MIN_SHOT_W + GAP));
  return Math.max(1, Math.min(MAX_COLS, fits, Math.max(1, shots)));
}

export interface StoryboardSurfaceProps {
  source: string;
  onChange: (source: string) => void;
  readOnly?: boolean;
  /** Identifies this block to the canvas shell, which mounts the toolbar. */
  blockId: string;
}

export function StoryboardSurface({
  source,
  onChange,
  readOnly = false,
  blockId,
}: StoryboardSurfaceProps) {
  const shell = useCanvasShell();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  /**
   * The board, held locally and written back on a debounce — the same bargain
   * the canvas makes, for the same reason: typing must stay O(1) and a
   * keystroke is not worth a document mutation.
   *
   * `mine` is the last string this component wrote. A prop equal to it is our
   * own write coming home and is ignored; anything else is a real outside
   * change (a collaborator, an AI edit, an undo) and is adopted.
   */
  const [board, setBoard] = useState<Storyboard>(() => read(source));
  /**
   * The authoritative board, moved SYNCHRONOUSLY by every write and adoption.
   *
   * Not a mirror of `board` kept fresh by an effect — that was the original
   * design, and it is how the first storyboards lost their drawings: a passive
   * effect runs after paint, so any write landing between another write's
   * commit and its effect composed against a stale board and silently dropped
   * whatever the first had added. A shot store's debounced scene flush and a
   * click on the bar are exactly that pair. With the ref moved inside `write`
   * itself, there is no window: writers compose against what the last writer
   * left, whatever React is doing.
   */
  const boardRef = useRef(board);
  const mine = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (source === mine.current) return;
    const next = read(source);
    boardRef.current = next;
    setBoard(next);
  }, [source]);

  const write = useCallback(
    (up: (prev: Storyboard) => Storyboard, now = true) => {
      const next = up(boardRef.current);
      boardRef.current = next;
      setBoard(next);
      const flush = () => {
        const html = serializeStoryboard(next);
        // Idempotence: a flush that reproduces the last write says nothing.
        // Without it, echoes rewrite identical data into the document — and
        // every one is a CRDT update every collaborator has to download.
        if (html === mine.current) return;
        mine.current = html;
        onChangeRef.current(html);
      };
      if (timer.current) clearTimeout(timer.current);
      if (now) flush();
      else timer.current = setTimeout(flush, NOTE_FLUSH_MS);
    },
    [],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Width drives the column count, which drives the scale. Measured rather than
  // guessed from the viewport: the block sits in a column whose width is the
  // document's business, not the window's.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * While the width grip is held the pin stands aside, exactly as the album's
   * does: a block being resized should re-column before your eyes, and the
   * commit at the grip's release drops the pin for good. The bar re-pins after.
   */
  const [fitting, setFitting] = useState(false);
  const cols = columnsFor(width, board.shots.length, fitting ? undefined : board.cols);
  /** The most columns this board could hold — the + button's far edge. */
  const most = columnsFor(width, board.shots.length, MAX_COLS);
  const shotW = width > 0 ? (width - GAP * (cols - 1)) / cols : SHOT_W;
  const scale = shotW / SHOT_W;
  const frameH = shotHeight(board.ratio);

  // One object for as long as its numbers hold. Passed fresh each render it
  // would rebuild the shot's `changeTool`, whose api the shot republishes —
  // and a republish re-renders this component, which would build it again.
  const shotFrame = useMemo(
    () => ({ w: SHOT_W, h: frameH, scale }),
    [frameH, scale],
  );

  const setShot = useCallback(
    (index: number, patch: Partial<Shot>, now = true) => {
      write(
        (prev) => ({
          ...prev,
          shots: prev.shots.map((shot, i) =>
            i === index ? { ...shot, ...patch } : shot,
          ),
        }),
        now,
      );
    },
    [write],
  );

  /**
   * The shot the toolbar speaks for: whichever was touched last.
   *
   * A board is many canvases and there is one toolbar, so the shell needs a
   * single answer. Keyed by index as well as block id, so moving between shots
   * re-claims it — the shell compares block ids to decide whether a claim is
   * still ours.
   */
  const [active, setActive] = useState(0);
  /** The shot open at full size, if any — see {@link FullscreenShot}. */
  const [wantFull, setWantFull] = useState<number | null>(null);
  // Derived, not synced: a collaborator deleting shots under an open view
  // leaves the state pointing past the list, and past the list means closed.
  const full =
    wantFull !== null && wantFull < board.shots.length ? wantFull : null;

  /**
   * Whether the shell's active canvas is one of this board's — a shot, or the
   * fullscreen view, both claimed as `${blockId}:…`. The bar and the active
   * highlight live and die with this, exactly as the side panels do: a press
   * outside the canvas chrome clears the shell, and all of it leaves together.
   */
  const claimed = !readOnly && !!shell.active?.blockId.startsWith(`${blockId}:`);
  const apis = useRef(new Map<number, CanvasApi>());
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  });

  /**
   * The active shot's api, as STATE rather than a map lookup: the bar beside
   * the board renders the pressed tool from it, so a tool change — which
   * arrives as a fresh api through `onApi` — has to reach React, not a ref.
   */
  const [shotApi, setShotApi] = useState<CanvasApi | null>(null);

  const boardApi = useMemo(
    () => ({
      ratio: board.ratio,
      shots: board.shots.length,
      setRatio: (ratio: Ratio) => write((prev) => ({ ...prev, ratio })),
      addShot: () => {
        write((prev) => ({
          ...prev,
          shots: [...prev.shots, { scene: "", note: "" }],
        }));
        setActive(boardRef.current.shots.length - 1);
      },
      /**
       * The column pin — the album's, on the board's bar. Stepped from
       * whatever is SHOWING rather than from the stored pin, so the first
       * press always does something visible.
       */
      cols,
      most,
      pinned: board.cols !== undefined,
      pin: (delta: number) => {
        const next = Math.min(most, Math.max(1, cols + delta));
        if (next === cols) return;
        write((prev) => ({ ...prev, cols: next }));
      },
      /** Back to as many as the width holds, written by omission. */
      unpin: () => write(({ cols: _pinned, ...rest }) => rest),
    }),
    [board.ratio, board.shots.length, board.cols, cols, most, write],
  );

  /**
   * The shell, behind a ref.
   *
   * Deliberately not a dependency of `publish`: claiming the shell changes the
   * workspace's active canvas, which rebuilds the shell object, which would
   * rebuild `publish` and re-run the effect below — a loop that publishes for
   * ever. Read through a ref, the claim is an event with no way back to itself.
   */
  const shellRef = useRef(shell);
  useEffect(() => {
    shellRef.current = shell;
  });

  const publish = useCallback(
    (index: number) => {
      const api = apis.current.get(index);
      if (!api) return;
      shellRef.current.set({
        blockId: `${blockId}:${index}`,
        api: { ...api, board: boardApi },
      });
    },
    [blockId, boardApi],
  );

  // Republished while this board holds the shell, so the toolbar's ratio
  // readout is never a turn behind what it points at — and when the fullscreen
  // view closes, which is what hands the claim back to the tile. While that
  // view is open it holds the claim itself; publishing here would take it back
  // mid-edit. `publish` depends only on values a publish cannot itself change,
  // and `claimed` is a boolean a republish keeps true, so no publish loop.
  useEffect(() => {
    if (claimed && full === null) publish(active);
  }, [claimed, full, publish, active]);

  const claim = (index: number) => {
    setActive(index);
    setShotApi(apis.current.get(index) ?? null);
    publish(index);
  };

  const openFull = (index: number) => {
    setActive(index);
    setShotApi(apis.current.get(index) ?? null);
    setWantFull(index);
  };

  const closeFull = useCallback(() => setWantFull(null), []);

  /** The fullscreen view's claim — its own id, so the panels turn over to it. */
  const claimFull = useCallback(
    (api: CanvasApi) => {
      shellRef.current.set({
        blockId: `${blockId}:fs${full}`,
        api: { ...api, board: boardApi },
      });
    },
    [blockId, full, boardApi],
  );

  const removeShot = (index: number) => {
    // The last shot stays: an empty board reads back as three defaults.
    if (boardRef.current.shots.length <= 1) return;
    write((prev) => ({
      ...prev,
      shots: prev.shots.filter((_, i) => i !== index),
    }));
    // The `apis` map needs no fixing: its keys are render positions, and the
    // component at each position — whose api the entry holds — is keyed the
    // same way, so both shift together and the unmounting tail removes itself.
    const next = Math.min(
      active > index ? active - 1 : active,
      boardRef.current.shots.length - 1,
    );
    setActive(next);
    setShotApi(apis.current.get(next) ?? null);
  };

  /**
   * The width grip — the album's, on a board.
   *
   * During the drag the width is written straight to the element; the resize
   * observer above reads it back, so the columns re-count and the shots
   * re-scale live under the pointer. That IS the interaction: a slight scale
   * until the width crosses a column boundary, then a snap to the new count.
   * React learns the number once, from the commit on release.
   */
  const onGripDown = (event: ReactPointerEvent) => {
    const el = wrap.current;
    if (event.button !== 0 || !el) return;
    event.preventDefault();
    const startX = event.clientX;
    const startW = el.offsetWidth;
    const room = el.closest("main")?.clientWidth ?? window.innerWidth;
    const limit = Math.max(MIN_BOARD_W, room - 32);
    let next = startW;
    let moved = false;
    const move = (e: PointerEvent) => {
      if (!moved) setFitting(true);
      moved = true;
      next = Math.round(Math.min(limit, Math.max(MIN_BOARD_W, startW + e.clientX - startX)));
      el.style.width = `${next}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setFitting(false);
      // A press that never moved is a click — and half of a double-click, so
      // it must neither write the document nor touch the element: clearing
      // the width here flashed the board back to column width for a frame,
      // which moved the grip out from under the double-click's second press.
      // A drag that ends where it began hands back what it borrowed instead,
      // or a stale inline width would pin a board React believes is fluid.
      if (next === startW) {
        if (moved) el.style.width = "";
        return;
      }
      // Left standing on the element: React renders this same number next
      // commit and owns the property from there. The pin goes with the drag —
      // resizing is choosing to let the width decide again.
      write(({ cols: _pinned, ...prev }) => ({ ...prev, w: next }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Back to the document column: width and pin both forgotten. */
  const fitWidth = () => {
    write(({ w: _w, cols: _pinned, ...rest }) => rest);
  };

  /**
   * Keeps the bar at the board's right shoulder, and on screen.
   *
   * It wants to sit just past the board's edge. When the board has been
   * widened past what the editor pane can show — the pane is the `<main>`
   * this block lives in, and its right edge is where the side panels begin —
   * the bar gives up following the edge and holds at the pane's, which is the
   * sticky the width grip needs: however wide the board, its tools stay
   * reachable. Written straight to the element; a bar that re-rendered on
   * every grip frame would make the resize the most expensive thing on the
   * page.
   */
  const barDock = useRef<HTMLDivElement>(null);
  const hasBar = claimed && full === null && shotApi !== null;
  useLayoutEffect(() => {
    const el = barDock.current;
    const host = wrap.current;
    if (!el || !host || !hasBar) return;
    const place = () => {
      const pane = host.closest("main");
      const edge =
        (pane ? pane.getBoundingClientRect().right : window.innerWidth) - BAR_EDGE;
      const r = host.getBoundingClientRect();
      const left = Math.min(r.width + BAR_GAP, edge - r.left - el.offsetWidth);
      el.style.left = `${Math.round(Math.max(0, left))}px`;
      el.style.visibility = "visible";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    const pane = host.closest("main");
    if (pane) observer.observe(pane);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [hasBar]);

  return (
    <div
      ref={wrap}
      className="nt-sb-wrap"
      contentEditable={false}
      style={board.w !== undefined ? { width: board.w } : undefined}
    >
      <div
        className="nt-sb"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}
      >
        {board.shots.map((shot, i) => (
          <div
            key={i}
            className={`nt-sb-shot${i === active && claimed ? " is-active" : ""}`}
            // Only the canvas claims the shell. A press on the note or the
            // chrome is a press outside it: the workspace clears the claim,
            // and the bar and the panels leave together — clicking a note is
            // clicking prose.
            onPointerDownCapture={
              readOnly
                ? undefined
                : (e) => {
                    if (e.target instanceof Element && e.target.closest(".nt-canvas"))
                      claim(i);
                  }
            }
          >
            <CanvasSurface
              source={shot.scene}
              onChange={(scene) => setShot(i, { scene })}
              readOnly={readOnly}
              frame={shotFrame}
              onApi={(api) => {
                if (api) apis.current.set(i, api);
                else apis.current.delete(i);
                if (i !== activeRef.current || readOnly) return;
                setShotApi(api);
                // A fresh api reaches the shell only while this board holds
                // it — a mounting shot must not take the claim from whatever
                // is actually being edited.
                if (api && shellRef.current.active?.blockId.startsWith(`${blockId}:`))
                  publish(i);
              }}
            />
            {!readOnly && (
              <div className="nt-sb-chrome">
                <button
                  type="button"
                  aria-label="Open shot full screen"
                  onClick={() => openFull(i)}
                >
                  {EXPAND}
                </button>
                {board.shots.length > 1 && (
                  <button
                    type="button"
                    aria-label="Remove shot"
                    onClick={() => removeShot(i)}
                  >
                    <X />
                  </button>
                )}
              </div>
            )}
            <div className="nt-sb-num">{i + 1}</div>
            <textarea
              className="nt-sb-note"
              value={shot.note}
              readOnly={readOnly}
              rows={3}
              spellCheck={false}
              placeholder={i === 0 ? "What happens…" : undefined}
              onChange={(e) => setShot(i, { note: e.target.value }, false)}
              // The board is a void node in the document; without this a
              // keystroke reaches ProseMirror as well as the field.
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        ))}
      </div>

      {!readOnly && (
        <div
          className="nt-sb-grip"
          role="separator"
          aria-label="Resize storyboard width"
          title="Drag to resize · double-click to fit the column"
          onPointerDown={onGripDown}
          onDoubleClick={fitWidth}
        />
      )}

      {hasBar && shotApi && (
        <div ref={barDock} className="nt-sb-bar-dock">
          <StoryboardToolbar api={shotApi} board={boardApi} />
        </div>
      )}

      {!readOnly && full !== null && (
        <FullscreenShot
          scene={board.shots[full].scene}
          frameH={frameH}
          board={boardApi}
          onScene={(scene) => setShot(full, { scene })}
          onClaim={claimFull}
          onClose={closeFull}
        />
      )}
    </div>
  );
}

function read(source: string): Storyboard {
  const board = source.trim() ? parseStoryboard(source) : emptyStoryboard();
  // A board with no shots has nothing to draw and no way back; the block is
  // only ever created with shots, so this is a corrupt-source floor.
  return board.shots.length ? board : emptyStoryboard();
}
