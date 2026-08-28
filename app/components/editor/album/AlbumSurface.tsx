"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ChevronsLeftRight,
  ChevronsRightLeft,
  Columns,
  MediaPlus,
  Minus,
  Plus,
  Shuffle,
  X,
} from "@/app/components/Icons";
import { Tooltip } from "@/app/components/Tooltip";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { useReadOnly } from "../readOnly";
import { Lightbox } from "./Lightbox";
import { handlesFor, indexByHandle } from "./handle";
import { applyAlbumOps, type AlbumOp } from "./ops";
import { parseAlbum } from "./parse";
import { serializeAlbum } from "./serialize";
import { ALBUM_ACCEPT, ingest, type Pending } from "./upload";
import {
  ALBUM_GUTTER,
  ALBUM_MIN_W,
  MAX_COLS,
  type Album,
  type AlbumItem,
} from "./types";
import { columnsFor, dropIndex, layout, type Box } from "./waterfall";
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
 * CARRYING one is a pointer gesture against that same geometry. The tile in
 * hand is the real element, glued to the press point by a pair of offsets no
 * render touches; where it would land is `dropIndex`, asked of the layout that
 * is on screen — its settled coordinates, straight from the packer. Nothing
 * measures the DOM while tiles are moving, so nothing the animation does can
 * change the answer; what keeps the answer from arguing with itself as the
 * layout re-packs under the pointer is in `dropIndex`, and the beat of rest
 * below.
 */

/** Pointer past this and a press on a tile was a drag, not a click. */
const DRAG_SLOP = 4;

/**
 * After a re-pack, how long the answer stands before it may change again.
 * The re-pack moves tile boundaries under a pointer that has not moved, and an
 * answer re-asked against them instantly can disagree with itself forever.
 * Shorter than the glide, so it is felt as steadiness rather than lag.
 */
const RETHINK = 120;

/** Within this many pixels of the scroller's edge, carrying starts to scroll. */
const CRAWL_EDGE = 56;
/** The fastest the document scrolls under a carried picture, per frame. */
const CRAWL_MAX = 16;

/**
 * A pointer drag, with its listeners removed however it ends. The flag handed
 * to `onEnd` says whether the pointer was released — Escape and a platform
 * `pointercancel` (an incoming call, a palm) both end the gesture without one.
 * Returns its own cancel, for a component unmounted mid-carry.
 */
function drag(
  onMove: (event: PointerEvent) => void,
  onEnd: (ok: boolean) => void,
): () => void {
  const stop = (ok: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key);
    onEnd(ok);
  };
  const up = () => stop(true);
  const cancel = () => stop(false);
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancel();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key);
  return cancel;
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
  const stage = useRef<HTMLDivElement>(null);
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

  /**
   * A change said in the shared vocabulary — the same seven verbs the agent's
   * `album_edit` writes, applied by the same function (`ops.ts`). The bar's
   * buttons and a tool call are then not two paths that must be kept in step;
   * they are one path with two callers.
   *
   * The carry in `grab` is the one exception, and deliberately: what it commits
   * is the arrangement already on screen, settled by the packer under the
   * pointer, and re-deriving that through a reorder would be a longer way of
   * writing down the list it is already holding.
   */
  const run = useCallback(
    (...ops: AlbumOp[]) => applyAlbumOps(view.current, ops).album,
    [],
  );

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
   * Whether the album is the thing being worked on, which is what the bar
   * follows. Claimed the way the canvas claims the screen's panels — on the
   * way down, pointer or focus — and released when a press lands elsewhere.
   */
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!active) return;
    const release = (event: PointerEvent) => {
      // The lightbox is portalled to the body: working in it is still working
      // on the album, wherever the nodes ended up.
      if (open !== null) return;
      if (wrap.current?.contains(event.target as Node)) return;
      setActive(false);
    };
    window.addEventListener("pointerdown", release, true);
    return () => window.removeEventListener("pointerdown", release, true);
  }, [active, open]);
  /** The picture in hand: its name, and the place it was lifted from. */
  const [carry, setCarry] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  /** The one gliding home after a drop, kept on top until it lands. */
  const [homing, setHoming] = useState<string | null>(null);
  /** What a screen reader is told after a keyboard move. */
  const [said, setSaid] = useState("");
  /** Ends a drag whose component was unmounted from under it. */
  const abort = useRef<(() => void) | null>(null);
  useEffect(() => () => abort.current?.(), []);

  /**
   * What a gesture is showing, and the sources it stands in for.
   *
   * A preview outlives its gesture on purpose. A commit does not reach this
   * component as a prop until the editor has been round a render, so a preview
   * that stopped applying the instant the pointer came up put one frame of the
   * old arrangement on screen before the new one arrived. It is keyed to two
   * sources — `from`, the one its commit wrote, and `over`, the one it
   * replaced and is standing in for until the write comes round — and applies
   * while the document says either. A source that is neither is somebody
   * else's edit, and the document wins.
   */
  const [preview, setPreview] = useState<{
    from: string;
    over?: string;
    items: AlbumItem[];
  } | null>(null);
  const [sizing, setSizing] = useState<{
    from: string;
    over?: string;
    at: number;
    span: number;
  } | null>(null);

  const items = useMemo(() => {
    let base = album.items;
    if (preview) {
      if (preview.from === source || preview.over === source) base = preview.items;
      // Mid-carry the document may grow underneath — an upload landing. The
      // newcomers ride along at the back; a document that changed any other
      // way is no longer the album this carry describes, and it wins.
      else if (carry && album.items.length >= preview.items.length)
        base = [...preview.items, ...album.items.slice(preview.items.length)];
    }
    if (!sizing || (sizing.from !== source && sizing.over !== source)) return base;
    return base.map((item, i) => (i === sizing.at ? { ...item, span: sizing.span } : item));
  }, [preview, sizing, source, album.items, carry]);

  const names = useMemo(() => handlesFor(items), [items]);

  // Painted in list order but MOUNTED in a fixed one: React must never move
  // these DOM nodes, because moving a node kills its in-flight transition —
  // the snap-instead-of-glide every earlier version of this drag had.
  const stable = useMemo(
    () =>
      names
        .map((name, index) => ({ name, index }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    [names],
  );

  // Outlines are laid out with the pictures, not after them: a file's shape is
  // known before its bytes are, so the tile it will occupy is already in place
  // and the arriving picture displaces nothing.
  const tiled = useMemo(() => [...items, ...pending], [items, pending]);
  const room = width || ALBUM_MIN_W;
  /**
   * While the width grip is held, the pin stands aside: a block being resized
   * should re-column before your eyes, the way it always has — and the commit
   * at the grip's release drops the pin for good. The bar re-pins after.
   */
  const [fitting, setFitting] = useState(false);
  const columns = columnsFor(room, tiled, fitting ? undefined : album.cols);
  /** The most columns this album could hold — the + button's far edge. */
  const most = columnsFor(room, tiled, MAX_COLS);
  const { boxes, height } = useMemo(
    () => layout(tiled, room, columns),
    [tiled, room, columns],
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
        onItem: (id, item, stats) => {
          commit(run({ op: "add", items: [item] }));
          setPending((list) => list.filter((waiting) => waiting.id !== id));
          // What the picture looks like, measured off the canvas the re-encode
          // already drew. Written beside the picture rather than into it, and
          // fire-and-forget: an index that does not land costs the agent a
          // captioning call later, and costs the person uploading nothing.
          if (stats) {
            void convex
              .mutation(api.imageMeta.put, { entries: [{ src: item.src, ...stats }] })
              .catch(() => {});
          }
        },
        onDrop: (id) => setPending((list) => list.filter((waiting) => waiting.id !== id)),
        onError: setRefused,
      });
    },
    [convex, commit, run, readOnly],
  );

  const remove = (index: number) => {
    commit(run({ op: "remove", items: [names[index]] }));
  };

  /**
   * The whole gesture, from press to landing.
   *
   * `dropIndex` is asked against the boxes of what is on screen — re-derived
   * from the list, not measured from the document, each time the answer moves
   * the pictures. Carrying costs no renders — the offsets go straight to the
   * element — and the preview re-packs only on the discrete beat the answer
   * actually changes.
   */
  const grab = (event: ReactPointerEvent, index: number) => {
    if (event.button !== 0) return;
    const tile = event.currentTarget as HTMLElement;
    const el = stage.current;
    if (!el) return;
    // Moves keep arriving when the pointer leaves the window mid-carry.
    tile.setPointerCapture?.(event.pointerId);
    const name = names[index];
    const carried = items[index];
    const press = { x: event.clientX, y: event.clientY };

    let live = false;
    /** The album without the carried picture; what the preview is built from. */
    let rest: AlbumItem[] = [];
    let insertion = index;
    let shown = items;
    /** What is on screen, in the packer's own terms — never measured. */
    let shownBoxes = boxes;
    let rested = 0;
    /** The stage's viewport place at lift, and now — apart only by scroll. */
    let origin = { left: 0, top: 0 };
    let at = origin;
    let client = press;
    let raf = 0;
    let scroller: Element | null = null;
    let edge = { top: 0, bottom: 0 };

    const placeCarried = () => {
      tile.style.setProperty("--dx", `${client.x - press.x + (origin.left - at.left)}px`);
      tile.style.setProperty("--dy", `${client.y - press.y + (origin.top - at.top)}px`);
    };

    const aim = () => {
      const next = Math.min(
        dropIndex(
          { x: client.x - at.left, y: client.y - at.top },
          shownBoxes,
          columns,
          insertion,
        ),
        rest.length,
      );
      // The only render a move can cause: when the answer changed, and the
      // last one has had its beat to land.
      if (next === insertion) return;
      const now = performance.now();
      if (now - rested < RETHINK) return;
      rested = now;
      insertion = next;
      shown = [...rest.slice(0, insertion), carried, ...rest.slice(insertion)];
      shownBoxes = layout([...shown, ...pending], room, columns).boxes;
      setPreview({ from: source, items: shown });
    };

    const onScroll = () => {
      // The stage moved under a glued pointer: re-base, and ask again.
      at = el.getBoundingClientRect();
      placeCarried();
      aim();
    };

    const crawl = () => {
      if (scroller) {
        const above = client.y - (edge.top + CRAWL_EDGE);
        const below = edge.bottom - CRAWL_EDGE - client.y;
        if (above < 0) scroller.scrollTop -= CRAWL_MAX * Math.min(1, -above / CRAWL_EDGE) ** 2;
        else if (below < 0) scroller.scrollTop += CRAWL_MAX * Math.min(1, -below / CRAWL_EDGE) ** 2;
      }
      raf = requestAnimationFrame(crawl);
    };

    const lift = () => {
      live = true;
      // Grabbed mid-glide, the tile's truth is its live translate, not its
      // box — the drag's one and only style read of the document.
      const m = new DOMMatrix(getComputedStyle(tile).transform);
      // Flushed, so the freeze is already on the element when the first
      // offset lands right after — otherwise that offset composes over the
      // packer's coordinates for a frame and the picture starts with a hop.
      flushSync(() => {
        setCarry({ name, x: m.m41, y: m.m42 });
        setHoming(null);
      });
      rest = items.filter((_, i) => i !== index);
      origin = at = el.getBoundingClientRect();
      scroller = wrap.current?.closest("main") ?? document.scrollingElement;
      const zone =
        !scroller || scroller === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : scroller.getBoundingClientRect();
      edge = { top: zone.top, bottom: zone.bottom };
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      raf = requestAnimationFrame(crawl);
    };

    abort.current = drag(
      (moved) => {
        client = { x: moved.clientX, y: moved.clientY };
        if (!live) {
          // Read-only keeps the press — a viewer still opens pictures — and
          // loses only the half of the gesture that would rewrite the document.
          if (
            readOnly ||
            Math.abs(client.x - press.x) + Math.abs(client.y - press.y) < DRAG_SLOP
          )
            return;
          lift();
        }
        placeCarried();
        aim();
      },
      (ok) => {
        abort.current = null;
        cancelAnimationFrame(raf);
        window.removeEventListener("scroll", onScroll, true);
        if (!live) {
          // A press that never travelled is a click, and opens the picture.
          if (ok) setOpen(index);
          return;
        }
        // Whatever is on screen is what gets written, including when the
        // pointer came up over a gap. A photo can land from an upload while a
        // drag is in flight, and the list being carried has never heard of it.
        // Uploads only ever append, so whatever sits past the end of this list
        // is exactly what arrived, and it keeps its place at the back. An album
        // that got SHORTER underneath — an undo, an AI edit — is no longer the
        // album this reorder describes. Escape, or the platform taking the
        // pointer, writes nothing at all.
        let after: typeof preview = null;
        if (ok) {
          const settled = view.current.items;
          if (settled.length >= shown.length) {
            const landed = [...shown, ...settled.slice(shown.length)];
            const next = { ...view.current, items: landed };
            // Put back where it came from: nothing to write, and writing it
            // anyway would put an undo step in the way of whatever came before.
            if (serializeAlbum(next) !== source)
              after = { from: commit(next), over: source, items: landed };
          }
        }
        // Flushed, and only then the offsets removed: the class swap, the
        // slot's coordinates and the offsets' removal reach the browser as one
        // style recalc, so the tile transitions from exactly where it was
        // painted. Removed first, a paint could land between the two and show
        // the picture back where it was lifted for a frame.
        flushSync(() => {
          setCarry(null);
          if (!stillness) setHoming(name);
          setPreview(after);
        });
        tile.style.removeProperty("--dx");
        tile.style.removeProperty("--dy");
      },
    );
  };

  /**
   * Pinning the column count is the album-wide way to say how big the pictures
   * are: the same width across fewer columns is bigger pictures. Stepped from
   * whatever is showing, so the first press always does something visible.
   */
  const pin = (delta: number) => {
    const next = Math.min(most, Math.max(1, columns + delta));
    if (next === columns) return;
    commit(run({ op: "grid", cols: next }));
  };

  /** Back to as many as the width holds, written by omission. */
  const unpin = () => {
    commit(run({ op: "grid", cols: null }));
  };

  /** A new order nobody chose — re-dealt until it is actually new. */
  const shuffle = () => {
    const held = view.current.items;
    if (held.length < 2) return;
    const before = serializeAlbum(view.current);
    const handles = handlesFor(held);
    let dealt = view.current;
    for (let tries = 0; tries < 8; tries++) {
      const order = [...handles];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      dealt = run({ op: "order", items: order });
      if (serializeAlbum(dealt) !== before) break;
    }
    setPreview({ from: commit(dealt), over: source, items: dealt.items });
  };

  /**
   * The lightbox hands back a picture it re-cut; the width chosen stays, and
   * the first cut records what it was cut FROM — carried unchanged through
   * every later cut, and dropped again the moment the original is restored.
   */
  const replace = (index: number, next: AlbumItem) => {
    if (!view.current.items[index]) return;
    commit(run({ op: "replace", item: names[index], with: next }));
  };

  /** One document position per press, committed — the tiles glide to answer. */
  const move = (index: number, to: number) => {
    if (to < 0 || to >= view.current.items.length) return;
    const moved = run({ op: "move", item: names[index], to });
    setPreview({ from: commit(moved), over: source, items: moved.items });
    setSaid(`Moved to position ${to + 1} of ${moved.items.length}`);
  };

  /**
   * Making one picture bigger or smaller, in columns rather than pixels.
   *
   * A photo's size is its aspect ratio; the only thing there is to decide is
   * how much of the row it takes, and that is a whole number of columns — so
   * the affordance is a step, not a drag. A click a column, committed like any
   * edit, and the album re-packs to answer: the change gliding into place is
   * its own confirmation, which no elastic on a handle ever quite was.
   */
  const resize = (index: number, delta: number) => {
    // By handle, like the op below it. A step is relative to the width the
    // picture is ALREADY drawn at, and during a preview the picture at this
    // position is not the one the document has there.
    const item = view.current.items[indexByHandle(view.current.items).get(names[index]) ?? -1];
    if (!item) return;
    const wide = Math.min(columns, item.span ?? 1);
    const span = Math.min(columns, Math.max(1, wide + delta));
    if (span === wide) return;
    // Keyed like the reorder's preview: the new width shows now, and stands in
    // for the render the commit takes to come back as the prop.
    setSizing({
      from: commit(run({ op: "span", item: names[index], cols: span })),
      over: source,
      at: index,
      span,
    });
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
    let took = false;
    drag(
      (moved) => {
        const grown = startW + (moved.clientX - startX);
        const clamped = Math.round(Math.min(limit, Math.max(ALBUM_MIN_W, grown)));
        if (clamped === next) return;
        next = clamped;
        // The edge genuinely moving is what suspends a pinned column count:
        // a resizing block re-columns before your eyes, the way it always
        // has. A press that never travels keeps the pin.
        if (!took) {
          took = true;
          setFitting(true);
        }
        // Written straight to the element; React learns the number once, from
        // the source this commits. The ResizeObserver picks the change up and
        // re-packs, so the pictures rearrange as the edge moves.
        el.style.width = `${next}px`;
      },
      () => {
        if (!took) return;
        setFitting(false);
        commit(run({ op: "grid", width: next, cols: null }));
      },
    );
  };

  const fit = () => {
    if (wrap.current) wrap.current.style.width = "";
    commit(run({ op: "grid", width: null, cols: null }));
  };

  const empty = items.length === 0 && pending.length === 0;
  const slot = carry ? names.indexOf(carry.name) : -1;

  return (
    <div
      ref={wrap}
      className={`nt-album${over ? " is-over" : ""}${empty ? " is-empty" : ""}${
        readOnly ? " is-view" : ""
      }${carry ? " is-carrying" : ""}${stillness ? " is-still" : ""}`}
      contentEditable={false}
      style={album.w ? { width: album.w } : undefined}
      onPointerDownCapture={() => setActive(true)}
      onFocusCapture={() => setActive(true)}
      onBlurCapture={(event) => {
        // Focus walked out — a keyboard's way of pressing elsewhere. Null is
        // not out: it is a click on something unfocusable, which the pointer
        // listener already judged.
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget as Node)
        )
          setActive(false);
      }}
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
        <div ref={stage} className="nt-album-stage" style={{ height }}>
          {/* Where letting go puts it: a sunken well that glides between
              slots as the answer changes, under the tiles by document order. */}
          {slot >= 0 && boxes[slot] && (
            <div className="nt-album-slot" style={place(boxes[slot])} />
          )}

          {stable.map(({ name, index }) => (
            <Tile
              key={name}
              item={items[index]}
              index={index}
              count={items.length}
              // The one in hand keeps the place it was lifted from; the pair
              // of offsets the gesture writes carries it from there.
              box={
                carry?.name === name
                  ? { ...boxes[index], x: carry.x, y: carry.y }
                  : boxes[index]
              }
              held={carry?.name === name}
              homing={homing === name}
              columns={columns}
              autoplay={!stillness}
              observer={observer}
              readOnly={readOnly}
              onGrab={grab}
              onMove={move}
              onOpen={setOpen}
              onHome={() => setHoming(null)}
              onResize={resize}
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

      {/* The bar, while the album is the thing being worked on: the canvas
          toolbar's, one block over. Album-wide controls — how many columns
          (which is how big the pictures are), a shuffle, the way in for more
          files. */}
      {active && !readOnly && !empty && open === null && (
        <div className="nt-album-tools-dock">
          <div className="nt-album-tools" role="toolbar" aria-label="Album">
            <Tooltip label="Fewer, bigger">
              <button
                type="button"
                className="nt-album-tools-btn"
                aria-label="Fewer columns"
                disabled={columns <= 1}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pin(-1)}
              >
                <Minus />
              </button>
            </Tooltip>
            <Tooltip
              label={album.cols ? "Columns — double-click to let the width decide" : "Columns"}
            >
              <button
                type="button"
                className="nt-album-tools-count"
                aria-label={`${columns} columns`}
                aria-pressed={album.cols !== undefined}
                onPointerDown={(event) => event.preventDefault()}
                onDoubleClick={unpin}
              >
                <Columns />
                {columns}
              </button>
            </Tooltip>
            <Tooltip label="More, smaller">
              <button
                type="button"
                className="nt-album-tools-btn"
                aria-label="More columns"
                disabled={columns >= most}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pin(1)}
              >
                <Plus />
              </button>
            </Tooltip>

            <Tooltip label="Shuffle">
              <button
                type="button"
                className="nt-album-tools-btn"
                aria-label="Shuffle the order"
                disabled={items.length < 2}
                onPointerDown={(event) => event.preventDefault()}
                onClick={shuffle}
              >
                <Shuffle />
              </button>
            </Tooltip>

            <span className="nt-album-tools-sep" aria-hidden />

            <Tooltip label="Add photos or videos">
              <button
                type="button"
                className="nt-album-tools-add"
                aria-label="Add photos or videos"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => picker.current?.click()}
              >
                <MediaPlus />
                Add media
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {(pending.length > 0 || refused) && (
        <div className="nt-album-foot">
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

      <div className="nt-album-said" aria-live="polite">
        {said}
      </div>

      {open !== null && (
        <Lightbox
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onReplace={readOnly ? undefined : replace}
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
  item,
  index,
  count,
  box,
  held,
  homing,
  columns,
  autoplay,
  observer,
  readOnly,
  onGrab,
  onMove,
  onOpen,
  onHome,
  onResize,
  onRemove,
}: {
  item: AlbumItem;
  index: number;
  count: number;
  box: Box;
  held: boolean;
  homing: boolean;
  columns: number;
  autoplay: boolean;
  observer: () => IntersectionObserver;
  readOnly: boolean;
  onGrab: (event: ReactPointerEvent, index: number) => void;
  onMove: (index: number, to: number) => void;
  onOpen: (index: number) => void;
  onHome: () => void;
  onResize: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
}) {
  const keys = (event: ReactKeyboardEvent) => {
    // A key pressed on the chrome is the chrome's — Enter on a chip must not
    // also open the picture.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(index);
      return;
    }
    if (readOnly) return;
    const to =
      event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? index - 1
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? index + 1
          : null;
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    onMove(index, to);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${item.kind === "video" ? "Video" : "Photo"} ${index + 1} of ${count}${
        readOnly ? "" : ", arrow keys move it"
      }`}
      className={`nt-album-tile${held ? " is-held" : ""}${homing ? " is-homing" : ""}`}
      style={place(box)}
      // The gesture decides for itself what the press was: travel carries the
      // picture, stillness opens it on release.
      onPointerDown={(event) => onGrab(event, index)}
      onKeyDown={keys}
      onTransitionEnd={
        homing
          ? (event) => {
              // Landed. The chrome's own little fades bubble too — not ours.
              if (event.target === event.currentTarget) onHome();
            }
          : undefined
      }
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
          {/* Only worth offering where there is another column to grow into.
              A chip a direction, each shown only while it can do anything. */}
          {columns > 1 && (
            <span className="nt-album-size">
              {(item.span ?? 1) > 1 && (
                <button
                  type="button"
                  aria-label="Make narrower"
                  title="One column narrower"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onResize(index, -1);
                  }}
                >
                  <ChevronsRightLeft />
                </button>
              )}
              {Math.min(columns, item.span ?? 1) < columns && (
                <button
                  type="button"
                  aria-label="Make wider"
                  title="One column wider"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onResize(index, 1);
                  }}
                >
                  <ChevronsLeftRight />
                </button>
              )}
            </span>
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
