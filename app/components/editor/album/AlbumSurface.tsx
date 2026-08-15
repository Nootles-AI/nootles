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
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
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
import { columnsFor, layout, type Box } from "./waterfall";
import "./album.css";

/**
 * The album block, assembled.
 *
 * Two jobs, split along the line where each is done best.
 *
 * WHERE the pictures go is `waterfall.ts` — shortest column first, from aspect
 * ratios alone, so the arrangement is known before anything loads and a tile
 * that moves moves between two coordinates we can transition between. No
 * library does this from ratios: they measure rendered elements, which means
 * laying out twice and the reflow that comes with it.
 *
 * CARRYING one is `@dnd-kit`. Everything that made the hand-written version bad
 * lives there instead now: when a press becomes a drag, what is under the
 * pointer, when that answer is allowed to change, and the copy that follows the
 * cursor. The measuring strategy below is the important line — droppable rects
 * are taken once, BEFORE the drag, so the tiles moving out of the way cannot
 * change the answer about where the picture would land. That feedback loop is
 * what made the first version stutter.
 */

/** Pointer past this and a press on a tile was a drag, not a click. */
const DRAG_SLOP = 4;

/**
 * dnd-kit moves sortable items by transforming them. Here it must not: the
 * packer decides where every tile is, and the two would fight over the same
 * property. What dnd-kit is here for is the gesture, not the geometry.
 */
const noTransform = () => null;

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

/**
 * A name per picture that survives the round trip through the document.
 *
 * The source, which is unique per upload; the suffix covers the one case it can
 * repeat, which is markup naming the same picture twice. Object identity cannot
 * do this job — every commit re-serializes the album and the prop comes back to
 * be parsed again, so every object is replaced each time.
 */
function namesOf(items: readonly AlbumItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item.src) ?? 0;
    seen.set(item.src, n + 1);
    return n ? `${item.src}#${n}` : item.src;
  });
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
  const [dragged, setDragged] = useState<string | null>(null);
  /**
   * When the last drag ended. A drag that finishes over the tile it started on
   * still produces a click, and opening the picture every time somebody nudged
   * one would be its own bug.
   */
  const dropped = useRef(0);

  /**
   * What a gesture is showing, and the source it is showing it INSTEAD of.
   *
   * A preview outlives its gesture on purpose. A commit does not reach this
   * component as a prop until the editor has been round a render, so dropping
   * the preview the instant the pointer came up put one frame of the old
   * arrangement on screen before the new one arrived. Keyed to a source, a
   * preview stops applying once the document says the same thing, and nothing
   * has to decide when that was.
   */
  const [preview, setPreview] = useState<{ from: string; items: AlbumItem[] } | null>(null);
  const [sizing, setSizing] = useState<{ from: string; at: number; span: number } | null>(null);

  const items = useMemo(() => {
    const base = preview?.from === source ? preview.items : album.items;
    if (sizing?.from !== source) return base;
    return base.map((item, i) => (i === sizing.at ? { ...item, span: sizing.span } : item));
  }, [preview, sizing, source, album.items]);

  const names = useMemo(() => namesOf(items), [items]);

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

  const sensors = useSensors(
    // A press that does not travel is a click, and opens the picture.
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_SLOP } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  const onDragStart = ({ active }: DragStartEvent) => setDragged(String(active.id));

  const openPicture = (index: number) => {
    if (performance.now() - dropped.current < 250) return;
    setOpen(index);
  };

  /**
   * dnd-kit says when the answer changed; this only has to write it down. The
   * list built here is what is on screen AND what gets committed, so there is
   * no separate idea of "where the drop line is" that could disagree with the
   * result.
   */
  const onDragOver = ({ active, over: target }: DragOverEvent) => {
    if (!target || active.id === target.id) return;
    const from = names.indexOf(String(active.id));
    const to = names.indexOf(String(target.id));
    if (from < 0 || to < 0) return;
    setPreview({ from: source, items: arrayMove(items, from, to) });
  };

  const onDragEnd = ({ over: target }: DragEndEvent) => {
    setDragged(null);
    dropped.current = performance.now();
    if (!target) {
      setPreview(null);
      return;
    }
    // A photo can land from an upload while a drag is in flight, and the list
    // being carried has never heard of it. Uploads only ever append, so whatever
    // sits past the end of this list is exactly what arrived, and it keeps its
    // place at the back. An album that got SHORTER underneath — an undo, an AI
    // edit — is no longer the album this reorder describes.
    const settled = view.current.items;
    if (settled.length < items.length) {
      setPreview(null);
      return;
    }
    const landed = [...items, ...settled.slice(items.length)];
    const next = { ...view.current, items: landed };
    // Put back where it came from: nothing to write, and writing it anyway
    // would put an undo step in the way of whatever came before.
    if (serializeAlbum(next) === source) {
      setPreview(null);
      return;
    }
    setPreview({ from: commit(next), items: landed });
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
    const was = items[index].span ?? 1;
    const startX = event.clientX;
    const startSpan = Math.min(columns, was);
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
        setSizing({ from: source, at: index, span });
      },
      () => {
        if (span === was || index >= view.current.items.length) {
          setSizing(null);
          return;
        }
        const widened = view.current.items.map((item, i) =>
          i === index ? withSpan(item, span) : item,
        );
        // Kept, keyed to what the document now says, for the same reason the
        // reorder keeps its preview: dropping it here would show the old width
        // for the one frame before the new source arrives.
        setSizing({
          from: commit({ ...view.current, items: widened }),
          at: index,
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
  const carried = dragged ? names.indexOf(dragged) : -1;

  return (
    <div
      ref={wrap}
      className={`nt-album${over ? " is-over" : ""}${empty ? " is-empty" : ""}${
        readOnly ? " is-view" : ""
      }${dragged ? " is-carrying" : ""}${stillness ? " is-still" : ""}`}
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // The whole reason this is a library and not a hundred lines here:
          // rects are taken once, before the drag, so the tiles moving out of
          // the way cannot change the answer about where the picture lands.
          measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setDragged(null);
            dropped.current = performance.now();
            setPreview(null);
          }}
        >
          <SortableContext items={names} strategy={noTransform}>
            <div className="nt-album-stage" style={{ height }}>
              {items.map((item, index) => (
                <Tile
                  key={names[index]}
                  id={names[index]}
                  item={item}
                  index={index}
                  box={boxes[index]}
                  columns={columns}
                  autoplay={!stillness}
                  observer={observer}
                  readOnly={readOnly}
                  onOpen={openPicture}
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
          </SortableContext>

          {/* The copy under the cursor. dnd-kit places it and animates it back
              into the waterfall on release; the tile it came from stays where
              it would land, faded, which is the whole preview.

              Portalled to the body, and that is not tidiness. The overlay is
              positioned `fixed` at the tile's VIEWPORT coordinates, and any
              ancestor with a transform, a filter or containment re-bases those
              coordinates onto itself — so left where it was written, the
              picture is picked up a whole block away from the pointer. At the
              top of the document there is nothing left to re-base it. */}
          {typeof document !== "undefined" &&
            createPortal(
              <DragOverlay>
                {carried >= 0 && boxes[carried] ? (
                  <div
                    className="nt-album-carried"
                    style={{ width: boxes[carried].w, height: boxes[carried].h }}
                  >
                    <Picture item={items[carried]} />
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )}
        </DndContext>
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
            <p className="nt-album-note">{pending.length} still to come</p>
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

function Picture({
  item,
  autoplay,
  observer,
}: {
  item: AlbumItem;
  autoplay?: boolean;
  observer?: () => IntersectionObserver;
}) {
  if (item.kind === "video") {
    return (
      <video
        src={item.src}
        poster={item.poster}
        muted
        loop
        playsInline
        // Muted autoplay is the only kind a browser allows unasked, and the
        // only kind anyone wants from a grid of tiles.
        controls={autoplay === false}
        // Metadata only. A page of holiday videos that each fetched themselves
        // whole on sight is the opposite of easy to load; the poster covers the
        // moment between coming into view and playing.
        preload="metadata"
        ref={
          autoplay && observer
            ? (el) => {
                if (!el) return;
                const io = observer();
                io.observe(el);
                return () => io.unobserve(el);
              }
            : undefined
        }
      />
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element -- already sized and
       re-encoded on the way in, from a storage URL next/image has no loader
       for; the tile reserves its room, so there is no shift to fix */
    <img src={item.src} alt="" loading="lazy" decoding="async" draggable={false} />
  );
}

function Tile({
  id,
  item,
  index,
  box,
  columns,
  autoplay,
  observer,
  readOnly,
  onOpen,
  onStretch,
  onRemove,
}: {
  id: string;
  item: AlbumItem;
  index: number;
  box: Box;
  columns: number;
  autoplay: boolean;
  observer: () => IntersectionObserver;
  readOnly: boolean;
  onOpen: (index: number) => void;
  onStretch: (event: ReactPointerEvent, index: number) => void;
  onRemove: (index: number) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id,
    disabled: readOnly,
  });

  return (
    <div
      ref={setNodeRef}
      className={`nt-album-tile${isDragging ? " is-lifted" : ""}`}
      style={place(box)}
      {...attributes}
      {...listeners}
      // The sensor's distance constraint means a press that never travelled is
      // still a click, and a click on a picture opens it.
      onClick={() => onOpen(index)}
    >
      <Picture item={item} autoplay={autoplay} observer={observer} />

      {!readOnly && (
        <>
          <button
            type="button"
            className="nt-album-remove"
            aria-label="Remove"
            // Not the tile's gesture: neither a drag nor an open.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(index);
            }}
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
              onClick={(event) => event.stopPropagation()}
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
