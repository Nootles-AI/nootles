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
import { useConvex } from "convex/react";
import { X } from "@/app/components/Icons";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { useReadOnly } from "../readOnly";
import { Lightbox } from "./Lightbox";
import { parseAlbum } from "./parse";
import { serializeAlbum } from "./serialize";
import { ALBUM_ACCEPT, ingest, type Progress } from "./upload";
import {
  ALBUM_GUTTER,
  ALBUM_MIN_W,
  type Album,
  type AlbumItem,
} from "./types";
import { columnsFor, packColumns } from "./waterfall";
import "./album.css";

/**
 * The album block, assembled.
 *
 * The block's own source is the one thing that lives here: an album is a list
 * and a width, and every gesture — dropping files, removing one, dragging one
 * past another, widening the block — ends in one re-serialized album written
 * back onto the block. There are no ops and no store, because there is nothing
 * a diagram's scene has that a list of pictures needs.
 *
 * The waterfall itself is in `waterfall.ts`, and it is pure: aspect ratios in,
 * column assignments out. Nothing here measures a picture.
 */

/** Pointer past this and a press on a tile was a drag, not a click. */
const DRAG_SLOP = 4;

/** A pointer drag, with its listeners removed however it ends. */
function drag(
  onMove: (event: PointerEvent) => void,
  onEnd: () => void,
): void {
  const up = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onEnd();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** The widest the block may be drawn without escaping the document's scroller. */
function maxWidth(el: HTMLElement): number {
  const room = el.closest("main")?.clientWidth ?? window.innerWidth;
  return Math.max(ALBUM_MIN_W, room - ALBUM_GUTTER);
}

/**
 * Play what is on screen, pause what is not. One observer for the whole album:
 * a page of holiday videos all decoding at once is the difference between a
 * document that scrolls and one that stutters.
 */
function watchPlayback(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const video = entry.target as HTMLVideoElement;
    // A play() interrupted by the pause on the way out rejects; that is the
    // gesture working, not failing.
    if (entry.isIntersecting) void video.play().catch(() => {});
    else video.pause();
  }
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function AlbumSurface({
  source,
  onChange,
}: {
  source: string;
  onChange: (source: string) => void;
}) {
  const convex = useConvex();
  const readOnly = useReadOnly();
  const stillness = useMediaQuery("(prefers-reduced-motion: reduce)");
  const wrap = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const album = useMemo(() => parseAlbum(source), [source]);

  /**
   * The album as it now stands, written the moment a change is committed rather
   * than when the prop comes back. A batch of twenty photos lands in twenty
   * appends, several of them inside one tick — each has to build on the last,
   * and the prop is a render behind.
   */
  const view = useRef<Album>(album);
  const latest = useRef(onChange);
  useEffect(() => {
    view.current = album;
    latest.current = onChange;
  });

  const commit = useCallback((next: Album) => {
    view.current = next;
    latest.current(serializeAlbum(next));
  }, []);

  // Measured, not derived: the column count follows the room the block was
  // given, and only the element knows what that is. Laid out before paint so
  // the first frame is already the right number of columns.
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const playback = useRef<IntersectionObserver | null>(null);
  const observer = () =>
    (playback.current ??= new IntersectionObserver(watchPlayback, {
      threshold: 0.2,
    }));
  useEffect(
    () => () => {
      playback.current?.disconnect();
      playback.current = null;
    },
    [],
  );

  const [progress, setProgress] = useState<Progress | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  /** The order being dragged into. Null except during a reorder. */
  const [order, setOrder] = useState<AlbumItem[] | null>(null);
  const [held, setHeld] = useState<AlbumItem | null>(null);

  const items = order ?? album.items;
  const columns = columnsFor(width || ALBUM_MIN_W, items.length);
  const packed = useMemo(() => packColumns(items, columns), [items, columns]);

  /**
   * A tile's key is its source, not its position — a reorder moves the same
   * pictures rather than replacing them, and keying by position would remount
   * every tile the dragged one passes, restarting each video as it went. The
   * suffix is for the one case a source can repeat: markup that names the same
   * picture twice.
   */
  const keys = useMemo(() => {
    const seen = new Map<string, number>();
    return items.map((item) => {
      const n = seen.get(item.src) ?? 0;
      seen.set(item.src, n + 1);
      return n ? `${item.src}#${n}` : item.src;
    });
  }, [items]);

  const add = useCallback(
    async (files: File[]) => {
      if (readOnly || !files.length) return;
      setRefused(null);
      await ingest(convex, files, {
        onItem: (item) =>
          commit({ ...view.current, items: [...view.current.items, item] }),
        onProgress: setProgress,
        onError: setRefused,
      });
    },
    [convex, commit, readOnly],
  );

  const remove = (index: number) => {
    commit({
      ...view.current,
      items: view.current.items.filter((_, i) => i !== index),
    });
  };

  /** Which tile the pointer is over, in the order currently on screen. */
  const tileUnder = (event: PointerEvent): number | null => {
    const el = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-idx]");
    if (!el || !wrap.current?.contains(el)) return null;
    const index = Number(el.dataset.idx);
    return Number.isInteger(index) ? index : null;
  };

  /**
   * One gesture, two meanings: a press that goes nowhere opens the picture, and
   * a press that travels carries it. The list reorders live under the pointer
   * rather than showing a drop line — with every tile's shape already known,
   * the waterfall can repack on every move, so the album simply shows what
   * letting go would do.
   */
  const grab = (event: ReactPointerEvent, index: number) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let list = items.slice();
    let at = index;

    drag(
      (move_) => {
        // Read-only keeps the press — a viewer still opens pictures — and loses
        // only the half of the gesture that would rewrite the document.
        if (readOnly) return;
        if (!dragging) {
          const far =
            Math.abs(move_.clientX - startX) + Math.abs(move_.clientY - startY);
          if (far < DRAG_SLOP) return;
          dragging = true;
          setHeld(list[at]);
        }
        const to = tileUnder(move_);
        if (to === null || to === at) return;
        list = move(list, at, to);
        at = to;
        setOrder(list);
      },
      () => {
        if (!dragging) setOpen(at);
        else {
          // A photo can land from an upload while a drag is in flight, and the
          // list being carried has never heard of it. Anything that arrived
          // meanwhile is kept, on the end where it was appended; a list that no
          // longer describes this album at all — an undo, an AI edit — drops
          // the reorder rather than writing the album back as it used to be.
          const settled = view.current.items;
          const arrived = settled.filter((item) => !list.includes(item));
          if (list.every((item) => settled.includes(item))) {
            commit({ ...view.current, items: [...list, ...arrived] });
          }
        }
        setOrder(null);
        setHeld(null);
      },
    );
  };

  /**
   * The right grip. The left edge stays pinned to the text column, exactly as
   * the canvas's does, so widening an album grows it into the right margin and
   * the prose above and below keeps its own left edge.
   */
  const grip = (event: ReactPointerEvent) => {
    const el = wrap.current;
    if (event.button !== 0 || !el) return;
    event.preventDefault();
    const startX = event.clientX;
    const startW = el.offsetWidth;
    const limit = maxWidth(el);
    let next = startW;
    drag(
      (move_) => {
        const grown = startW + (move_.clientX - startX);
        next = Math.round(Math.min(limit, Math.max(ALBUM_MIN_W, grown)));
        // Written straight to the element; React learns the number once, from
        // the source this commits.
        el.style.width = `${next}px`;
      },
      () => commit({ ...view.current, w: next }),
    );
  };

  const fit = () => {
    const { w: _pinned, ...rest } = view.current;
    if (wrap.current) wrap.current.style.width = "";
    commit(rest);
  };

  const empty = items.length === 0 && !progress;

  return (
    <div
      ref={wrap}
      className={`nt-album${over ? " is-over" : ""}${empty ? " is-empty" : ""}`}
      contentEditable={false}
      style={album.w ? { width: album.w } : undefined}
      onDragOver={(event) => {
        if (readOnly || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setOver(false);
        }
      }}
      onDrop={(event) => {
        if (readOnly || !event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        void add(Array.from(event.dataTransfer.files));
      }}
    >
      {/* An empty album is an invitation, and a viewer has nothing to accept:
          on the share route it renders as the nothing it holds. */}
      {empty && !readOnly && (
        <button
          type="button"
          className="nt-album-drop"
          onClick={() => picker.current?.click()}
        >
          <span>Drop photos and videos here</span>
          <span className="is-low">or click to choose — several at once is fine</span>
        </button>
      )}

      {!empty && (
        <div className="nt-album-columns">
          {packed.map((column, c) => (
            <div className="nt-album-column" key={c}>
              {column.map((index) => {
                const item = items[index];
                return (
                  <Tile
                    key={keys[index]}
                    item={item}
                    index={index}
                    held={item === held}
                    autoplay={!stillness}
                    observer={observer}
                    readOnly={readOnly}
                    onGrab={grab}
                    onRemove={remove}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}

      {(progress || refused || (!empty && !readOnly)) && (
        <div className="nt-album-foot">
          {!empty && !readOnly && (
            <button
              type="button"
              className="nt-album-add"
              onClick={() => picker.current?.click()}
            >
              Add photos or videos
            </button>
          )}
          {progress && (
            <p className="nt-album-note">
              {progress.note || `${progress.done} of ${progress.total}`}
            </p>
          )}
          {refused && !progress && <p className="nt-album-note">{refused}</p>}
        </div>
      )}

      {!readOnly && (
        <input
          ref={picker}
          type="file"
          multiple
          accept={ALBUM_ACCEPT}
          className="nt-album-picker"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Cleared so choosing the same file twice in a row still counts.
            event.target.value = "";
            void add(files);
          }}
        />
      )}

      {!readOnly && (
        <div
          className="nt-album-grip"
          role="separator"
          aria-label="Resize album width"
          title="Drag to resize · double-click to fit the column"
          onPointerDown={grip}
          onDoubleClick={fit}
        />
      )}

      {open !== null && (
        <Lightbox
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Tile({
  item,
  index,
  held,
  autoplay,
  observer,
  readOnly,
  onGrab,
  onRemove,
}: {
  item: AlbumItem;
  index: number;
  held: boolean;
  autoplay: boolean;
  observer: () => IntersectionObserver;
  readOnly: boolean;
  onGrab: (event: ReactPointerEvent, index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div
      className={`nt-album-tile${held ? " is-held" : ""}`}
      data-idx={index}
      // The ratio, not the height: the browser reserves the exact room the
      // picture will need, so nothing moves when it finally arrives.
      style={{ aspectRatio: `${item.w} / ${item.h}` }}
      onPointerDown={(event) => onGrab(event, index)}
    >
      {item.kind === "video" ? (
        <video
          src={item.src}
          poster={item.poster}
          muted
          loop
          playsInline
          // Muted autoplay is the only kind a browser allows unasked, and the
          // only kind anyone wants from a grid of tiles.
          controls={!autoplay}
          // Metadata only. A page of holiday videos that each fetched
          // themselves whole on sight is the opposite of easy to load; the
          // poster covers the moment between coming into view and playing.
          preload="metadata"
          ref={
            autoplay
              ? (el) => {
                  if (!el) return;
                  const io = observer();
                  io.observe(el);
                  return () => io.unobserve(el);
                }
              : undefined
          }
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element -- already sized
           and re-encoded on the way in, from a storage URL next/image has no
           loader for; the tile reserves its room, so there is no shift to fix */
        <img src={item.src} alt="" loading="lazy" decoding="async" draggable={false} />
      )}

      {!readOnly && (
        <button
          type="button"
          className="nt-album-remove"
          aria-label="Remove"
          // Not the tile's gesture: a press here must not start a drag.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onRemove(index)}
        >
          <X />
        </button>
      )}
    </div>
  );
}
