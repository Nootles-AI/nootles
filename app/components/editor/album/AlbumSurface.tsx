"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useConvex } from "convex/react";
import { X } from "@/app/components/Icons";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { useReadOnly } from "../readOnly";
import { Lightbox } from "./Lightbox";
import { parseAlbum } from "./parse";
import { serializeAlbum } from "./serialize";
import { ALBUM_ACCEPT, ingest, type Pending } from "./upload";
import {
  ALBUM_GUTTER,
  ALBUM_MIN_W,
  GAP,
  type Album,
  type AlbumItem,
} from "./types";
import { columnsFor, dropIndex, layout, type Box } from "./waterfall";
import "./album.css";

/**
 * The album block, assembled.
 *
 * The block's own source is the one thing that lives here: an album is a list
 * and a width, and every gesture — dropping files, removing a picture, dragging
 * one past another, making one wider, widening the block — ends in one
 * re-serialized album written back onto the block.
 *
 * Every tile is absolutely positioned from a box the packer computed, which is
 * what makes the two things that move move WELL: a reorder or a change of
 * column count is a change of coordinates, so the tiles transition to their new
 * places instead of being re-laid-out underneath the eye. The tile being
 * dragged is the exception — it follows the pointer, written straight to the
 * DOM through a pair of custom properties so that carrying it costs no renders.
 */

/** Pointer past this and a press on a tile was a drag, not a click. */
const DRAG_SLOP = 4;


/** A pointer drag, with its listeners removed however it ends. */
function drag(onMove: (event: PointerEvent) => void, onEnd: () => void): void {
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

/** One column wide is the default, and a default is written by omission. */
function withSpan(item: AlbumItem, span: number): AlbumItem {
  const { span: _wasSpan, ...rest } = item;
  return span > 1 ? { ...rest, span } : rest;
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

  /** Writes the album back, and hands back the source it just became. */
  const commit = useCallback((next: Album) => {
    view.current = next;
    const text = serializeAlbum(next);
    latest.current(text);
    return text;
  }, []);

  // Measured, not derived: the column count follows the room the block was
  // given, and only the element knows what that is. Read before paint, so the
  // first frame is already the right arrangement rather than an animation into
  // it from a one-column guess.
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

  const [pending, setPending] = useState<Pending[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  /**
   * What a gesture is showing, and the source it is showing it INSTEAD of.
   *
   * Both of these outlive the gesture on purpose. A commit does not reach this
   * component as a prop until the editor has been round a render, so dropping
   * the preview the instant the pointer came up put one frame of the old order
   * on screen before the new one arrived — the flash. Keyed to a source, the
   * preview simply stops applying once the document says the same thing, and
   * nothing has to decide when that was.
   */
  const [order, setOrder] = useState<{ from: string; items: AlbumItem[] } | null>(null);
  const [sizing, setSizing] = useState<{ from: string; item: AlbumItem; span: number } | null>(null);
  /** The tile being carried, and where it was when it was picked up. */
  const [held, setHeld] = useState<{ item: AlbumItem; x: number; y: number } | null>(null);

  const items = useMemo(() => {
    const base = order?.from === source ? order.items : album.items;
    if (sizing?.from !== source) return base;
    return base.map((item) => (item === sizing.item ? { ...item, span: sizing.span } : item));
  }, [order, sizing, source, album.items]);

  // Outlines are laid out with the pictures, not after them: a file's shape is
  // known before its bytes are, so the tile it will occupy is already in place
  // and the arriving picture displaces nothing.
  const tiled = useMemo(() => [...items, ...pending], [items, pending]);
  const room = width || ALBUM_MIN_W;
  const columns = columnsFor(room, tiled);
  const { boxes, height } = useMemo(
    () => layout(tiled, room, columns),
    [tiled, room, columns],
  );

  /**
   * A tile's key is its source, not its position — a reorder moves the same
   * pictures rather than replacing them, and keying by position would remount
   * every tile the dragged one passes, restarting each video as it went. The
   * suffix is for the one case a source can repeat: markup naming it twice.
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
        onPending: (item) => setPending((list) => [...list, item]),
        onAdvance: (id, progress, note) =>
          setPending((list) =>
            list.map((item) => (item.id === id ? { ...item, progress, note } : item)),
          ),
        onItem: (id, item) => {
          commit({ ...view.current, items: [...view.current.items, item] });
          setPending((list) => list.filter((waiting) => waiting.id !== id));
        },
        onDrop: (id) => setPending((list) => list.filter((waiting) => waiting.id !== id)),
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

  /**
   * One gesture, two meanings: a press that goes nowhere opens the picture, and
   * a press that travels carries it.
   *
   * What is on screen during the carry is the list that would be written if the
   * pointer came up now — built here, shown by the waterfall, and committed
   * unchanged on release. There is no separate idea of "where the drop line is"
   * that could disagree with the result.
   */
  const grab = (event: ReactPointerEvent, index: number) => {
    if (event.button !== 0) return;
    const el = event.currentTarget as HTMLElement;
    const stage = el.parentElement;
    const startX = event.clientX;
    const startY = event.clientY;
    const from = boxes[index];
    const carried = items[index];

    let dragging = false;
    /** The album without the carried picture, and where those tiles sit. */
    let rest: AlbumItem[] = [];
    let restBoxes: readonly Box[] = [];
    let insertion = index;
    let preview = items;

    drag(
      (moved) => {
        const dx = moved.clientX - startX;
        const dy = moved.clientY - startY;
        if (!dragging) {
          // Read-only keeps the press — a viewer still opens pictures — and
          // loses only the half of the gesture that would rewrite the document.
          if (readOnly || Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
          dragging = true;
          rest = items.filter((item) => item !== carried);
          // Frozen for the whole drag. See `dropIndex`.
          restBoxes = layout(rest, room, columns).boxes;
          setHeld({ item: carried, x: from.x, y: from.y });
        }
        // Straight to the element. React owns where the tile was picked up
        // from; this pair is the distance it has been carried since, and the
        // two are composed in the stylesheet — so carrying a picture across the
        // album costs no renders at all.
        el.style.setProperty("--dx", `${dx}px`);
        el.style.setProperty("--dy", `${dy}px`);

        const rect = stage?.getBoundingClientRect();
        if (!rect) return;
        const next = dropIndex(
          { x: moved.clientX - rect.left, y: moved.clientY - rect.top },
          restBoxes,
          columns,
          insertion,
        );
        // The only thing that re-renders the album during a drag, and it can
        // only happen when the answer actually changes.
        if (next === insertion) return;
        insertion = next;
        preview = [...rest.slice(0, insertion), carried, ...rest.slice(insertion)];
        setOrder({ from: source, items: preview });
      },
      () => {
        el.style.removeProperty("--dx");
        el.style.removeProperty("--dy");
        setHeld(null);
        if (!dragging) {
          setOpen(index);
          return;
        }
        // A photo can land from an upload while a drag is in flight, and the
        // list being carried has never heard of it. Anything that arrived
        // meanwhile is kept, on the end where it was appended; a list that no
        // longer describes this album at all — an undo, an AI edit — drops the
        // reorder rather than writing the album back as it used to be.
        const settled = view.current.items;
        const arrived = settled.filter((item) => !preview.includes(item));
        if (!preview.every((item) => settled.includes(item))) {
          setOrder(null);
          return;
        }
        const landed = [...preview, ...arrived];
        setOrder({ from: commit({ ...view.current, items: landed }), items: landed });
      },
    );
  };

  /**
   * Making one picture bigger, in columns rather than pixels.
   *
   * A photo's size is its aspect ratio; the only thing there is to decide is how
   * much of the row it takes. Snapping to whole columns is what keeps the
   * waterfall a waterfall — and because the snap is discrete, the pictures it
   * displaces glide rather than tracking the pointer.
   */
  const stretch = (event: ReactPointerEvent, index: number) => {
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const item = items[index];
    const startX = event.clientX;
    const startSpan = Math.min(columns, item.span ?? 1);
    const step = (room - GAP * (columns - 1)) / columns + GAP;
    let span = startSpan;

    drag(
      (moved) => {
        const next = Math.min(
          columns,
          Math.max(1, startSpan + Math.round((moved.clientX - startX) / step)),
        );
        if (next === span) return;
        span = next;
        setSizing({ from: source, item, span });
      },
      () => {
        if (span === (item.span ?? 1)) {
          setSizing(null);
          return;
        }
        const widened = view.current.items.map((it) =>
          it === item ? withSpan(it, span) : it,
        );
        // Kept, keyed to what the document now says, for the same reason the
        // reorder keeps its preview: dropping it here would show the old width
        // for the one frame before the new source arrives.
        setSizing({
          from: commit({ ...view.current, items: widened }),
          item,
          span,
        });
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
      (moved) => {
        const grown = startW + (moved.clientX - startX);
        next = Math.round(Math.min(limit, Math.max(ALBUM_MIN_W, grown)));
        // Written straight to the element; React learns the number once, from
        // the source this commits. The ResizeObserver picks the change up and
        // re-packs, so the pictures rearrange as the edge moves.
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

  const empty = items.length === 0 && pending.length === 0;

  return (
    <div
      ref={wrap}
      className={`nt-album${over ? " is-over" : ""}${empty ? " is-empty" : ""}${
        readOnly ? " is-view" : ""
      }${held ? " is-carrying" : ""}${stillness ? " is-still" : ""}`}
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
        <div className="nt-album-stage" style={{ height }}>
          {items.map((item, index) => (
            <Tile
              key={keys[index]}
              item={item}
              index={index}
              // Frozen where it was picked up: the tile is being carried by the
              // pointer now, and its place in the list is no longer where it is.
              box={
                held?.item === item
                  ? { ...boxes[index], x: held.x, y: held.y }
                  : boxes[index]
              }
              held={held?.item === item}
              columns={columns}
              autoplay={!stillness}
              observer={observer}
              readOnly={readOnly}
              onGrab={grab}
              onStretch={stretch}
              onRemove={remove}
            />
          ))}

          {pending.map((waiting, index) => (
            <Outline
              key={waiting.id}
              pending={waiting}
              box={boxes[items.length + index]}
            />
          ))}
        </div>
      )}

      {(pending.length > 0 || refused || (!empty && !readOnly)) && (
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
          {pending.length > 0 && (
            <p className="nt-album-note">
              {pending.length} still to come
            </p>
          )}
          {refused && !pending.length && <p className="nt-album-note">{refused}</p>}
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

/** A tile's box, as the stylesheet reads it. */
function place(box: Box): CSSProperties {
  return {
    "--x": `${box.x}px`,
    "--y": `${box.y}px`,
    width: box.w,
    height: box.h,
  } as CSSProperties;
}

function Tile({
  item,
  index,
  box,
  held,
  columns,
  autoplay,
  observer,
  readOnly,
  onGrab,
  onStretch,
  onRemove,
}: {
  item: AlbumItem;
  index: number;
  box: Box;
  held: boolean;
  columns: number;
  autoplay: boolean;
  observer: () => IntersectionObserver;
  readOnly: boolean;
  onGrab: (event: ReactPointerEvent, index: number) => void;
  onStretch: (event: ReactPointerEvent, index: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div
      className={`nt-album-tile${held ? " is-held" : ""}`}
      style={place(box)}
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
        <>
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
          {/* Only worth offering where there is another column to grow into. */}
          {columns > 1 && (
            <div
              className="nt-album-stretch"
              role="separator"
              aria-label="Resize picture"
              title="Drag to make this picture wider"
              onPointerDown={(event) => onStretch(event, index)}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * A file with its place already taken and nothing in it yet.
 *
 * Drawn at the exact shape the picture will be, because the shape is read off
 * the file before any of the work starts — so this is the outline of THAT
 * photo, not a generic box, and the picture that replaces it moves nothing.
 */
function Outline({ pending, box }: { pending: Pending; box: Box }) {
  return (
    <div className="nt-album-outline" style={place(box)}>
      <div className="nt-album-bar">
        <div
          className="nt-album-bar-fill"
          style={{ transform: `scaleX(${Math.max(0.02, pending.progress)})` }}
        />
      </div>
      <p className="nt-album-outline-note">
        {pending.note || (pending.kind === "video" ? "Reading" : "Preparing")}
      </p>
    </div>
  );
}
