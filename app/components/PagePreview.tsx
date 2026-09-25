"use client";

import dynamic from "next/dynamic";
import {
  Component,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useConvex, useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { encodePreview } from "@/convex/previewShape";
import { openYDoc } from "@/app/lib/sync/ydocRead";
import { rememberPreview, seenPreview } from "@/app/lib/projectsCache";
import { parseAlbum } from "@/app/components/editor/album/parse";
import { parseLocation } from "./editor/location/parse";
import { describeStub } from "@/app/lib/notion/stub";
import type { AnyBlock } from "@/app/lib/ai/projection";
import type { YReader } from "@/app/lib/ai/snapshot";
import { COLUMN_WIDTH } from "@/app/lib/column";

const YJS_ON = process.env.NEXT_PUBLIC_YJS === "1";

/**
 * The closest together two reads of a page may be.
 *
 * A thumbnail wants seconds-freshness, not the editor's 500ms flush: a page
 * being edited in another tab otherwise bumps `seq` ten times a sentence, and
 * every card watching it rebuilds on every bump. Reads are spaced instead, so
 * an editing session next door costs the grid one rebuild every couple of
 * seconds however fast the typing is. The first read is not delayed.
 */
const SETTLE_MS = 2000;

/**
 * Reads once `SETTLE_MS` has passed since the last read, and returns the
 * cancel. Spacing rather than debouncing, so a page under continuous editing
 * still refreshes — a trailing debounce would never fire at all.
 */
function spacedRead(stamp: { current: number }, read: () => void) {
  const timer = setTimeout(
    () => {
      stamp.current = Date.now();
      read();
    },
    Math.max(0, SETTLE_MS - (Date.now() - stamp.current)),
  );
  return () => clearTimeout(timer);
}

/**
 * The width the document is written at. The thumbnail lays out at exactly this
 * and is then scaled into the card, so line breaks, heading sizes and diagram
 * geometry are the document's own rather than a small-screen reflow of it. That
 * is what makes this read as a picture of the page instead of a narrow copy of it.
 */
const DOC_WIDTH = COLUMN_WIDTH;

/** Past this nothing is above the crop, even on the tallest card. */
const MAX_BLOCKS = 18;

/** How far outside the viewport a card starts reading its page. */
const NEAR_MARGIN = "600px";

/**
 * True once the element has come within {@link NEAR_MARGIN} of the viewport,
 * and true from then on.
 *
 * Drawing a card means reading a whole document: a subscription, the snapshot,
 * the log behind it, and a Y.Doc rebuilt on the main thread. An account with
 * sixty projects paid all of that sixty times to fill the six cards a window
 * holds — and those six queued behind the other fifty-four. Staying true
 * afterwards is deliberate: a card scrolled past keeps its reader, so coming
 * back to it costs nothing.
 */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/** Loaded only for a page that has a diagram on it. */
const ThumbDiagram = dynamic(() => import("./ThumbDiagram"), { ssr: false });
/** Likewise KaTeX and its stylesheet — most pages have no maths. */
const ThumbMath = dynamic(() => import("./ThumbMath"), { ssr: false });

/**
 * A project's first page, drawn at document size and shrunk to fit the card.
 *
 * Read on the CLIENT, which is not a preference: the server can reach a page's
 * snapshot but not its document. Snapshots are written on a debounce that is
 * dropped whenever the server runs ahead, so a page can sit indefinitely with
 * edits that exist only as steps, and replaying those needs the BlockNote
 * schema — a browser bundle. `blocksFromSnapshot` is the same reader the chat's
 * `read_page` uses, so a thumbnail and the AI see one document.
 *
 * `aria-hidden` because it is a picture of content the card already names, and
 * because nothing in it is text meant to be read at this size.
 */
export const PagePreview = memo(function PagePreview({ docId }: { docId: string | null }) {
  return (
    <PreviewBoundary>
      <PreviewReader docId={docId} />
    </PreviewBoundary>
  );
});

/**
 * A thumbnail must never take the screen down with it. The queries below can
 * start erroring mid-view — a share revoked, a summary gone stale — and an
 * uncaught subscription error unmounts the whole app, not just this card. The
 * failed card draws its blank face instead.
 */
class PreviewBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div aria-hidden="true" className="nt-thumb is-empty">
          <span className="nt-thumb-blank" />
        </div>
      );
    }
    return this.props.children;
  }
}

function PreviewReader({ docId }: { docId: string | null }) {
  const convex = useConvex();
  // The card is fluid, so the shrink factor is measured rather than assumed —
  // and this is also what the viewport gate watches, so it is mounted from the
  // first paint whatever state the reading is in.
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);

  /*
   * The stored preview first (`schema.pagePreviews`): one small read, where
   * drawing a card from its document is a subscription, a snapshot, the log
   * behind it, BlockNote imported and a Y.Doc rebuilt on the main thread.
   * Writers keep it current, so it is live the way the document was.
   *
   * Everything below it is the long way round, taken only for a page nobody
   * has left a preview of yet — and it leaves one, so it is taken once.
   */
  // Not before Convex has the caller's token: a returning visitor's screen is
  // up ahead of it (`FirstRun`), and asked as nobody this read is refused —
  // which is an error, and an error blanks the card for good.
  const { isAuthenticated } = useConvexAuth();
  const stored = useQuery(
    api.previews.get,
    near && docId && isAuthenticated ? { docId } : "skip",
  );
  // Until it answers, the last preview this browser drew of the page: a card
  // remounted by a change of view, the palette's side pane, a return visit.
  // A round trip of skeleton otherwise, every time.
  const drawn = stored ?? (stored === undefined && near && docId ? seenPreview(docId) : undefined);
  const source = drawn?.blocks;
  const kept = useMemo(() => {
    if (source === undefined) return null;
    try {
      return JSON.parse(source) as AnyBlock[];
    } catch {
      return [];
    }
  }, [source]);
  const unkept = stored === null;
  useEffect(() => {
    if (docId && stored !== undefined) rememberPreview(docId, stored);
  }, [docId, stored]);

  /*
   * `meta` is the Yjs pipeline's version channel — a change in `seq` is what
   * re-reads — and it doubles as the answer to which pipeline this doc is on:
   * null means there is no `ydocs` row, which is precisely what `ydoc.state`
   * would have said the slow way. Asking `state` first cost every card an
   * extra query (one that re-derives access AND may call into the
   * prosemirror-sync component) and put the query that matters a whole round
   * trip behind it.
   */
  const meta = useQuery(
    api.ydoc.meta,
    YJS_ON && unkept && docId ? { docId } : "skip",
  );
  const yjs = YJS_ON && meta != null;
  const serveEnabled = useQuery(
    api.nmlMigration.nmlServeEnabled,
    yjs ? {} : "skip",
  );
  const authority = useQuery(
    api.nmlMigration.nmlAuthority,
    yjs && serveEnabled && docId ? { docId } : "skip",
  );
  // Undefined is "not answered yet", null is "answered: not a Yjs doc".
  const legacy = !YJS_ON || meta === null;
  const snapshot = useQuery(
    api.prosemirror.getSnapshot,
    unkept && docId && legacy ? { id: docId } : "skip",
  );
  const since = useQuery(
    api.prosemirror.getSteps,
    snapshot?.content ? { id: docId!, version: snapshot.version } : "skip",
  );

  const [read, setRead] = useState<AnyBlock[] | null>(null);
  const blocks = kept ?? read;
  // Held steady so the drawn page sits out this component's re-renders. There
  // are several per card — the gate, the token, the answer — and on a return
  // visit each of them was redrawing a page that had not changed.
  const page = useMemo(() => blocks?.slice(0, MAX_BLOCKS), [blocks]);
  const lastRead = useRef(0);
  const offered = useRef(false);

  /*
   * BlockNote is the heaviest thing in the app and this route has no other use
   * for it, so it is imported on demand. That makes the read asynchronous,
   * which is why it lands in state rather than being derived during render —
   * the effect is doing real work, not restating a prop.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (yjs) return;
    if (snapshot === undefined) return;
    if (!snapshot?.content) {
      setRead([]);
      return;
    }
    if (since === undefined) return;

    let cancelled = false;
    const cancel = spacedRead(lastRead, () => {
      void (async () => {
        const { blocksFromSnapshot } = await import("@/app/lib/ai/snapshot");
        if (cancelled) return;
        try {
          setRead(blocksFromSnapshot(snapshot.content, since.steps));
        } catch {
          // A document the reader cannot rebuild is a blank card, not a blank
          // screen. Nothing here is worth failing the projects list over.
          setRead([]);
        }
      })();
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, [yjs, snapshot, since]);

  // The Yjs read, re-run whenever `meta.seq` moves, against a document the
  // card keeps for as long as it is mounted.
  const live = useRef<{ docId: string; reader: YReader; cursor: number } | null>(
    null,
  );
  useEffect(
    () => () => {
      live.current?.reader.destroy();
      live.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!yjs || !docId || !meta) return;
    if (serveEnabled === undefined || (serveEnabled && authority === undefined)) return;
    let cancelled = false;
    const cancel = spacedRead(lastRead, () => {
      void (async () => {
        try {
          if (live.current && live.current.docId !== docId) {
            live.current.reader.destroy();
            live.current = null;
          }
          const { yReader } = await import("@/app/lib/ai/snapshot");
          if (cancelled) return;
          const card = (live.current ??= {
            docId,
            reader: yReader(),
            cursor: 0,
          });

          // The card's own document is what is read against, so a move in
          // `seq` costs the updates since the last read, not the page again.
          const opened = await openYDoc(convex, docId, card.cursor, (update) =>
            card.reader.apply([update]),
          );
          if (cancelled) return;
          // A fold took the snapshot out from under the read: nothing of it
          // was applied, and the `meta` that fold publishes reads again.
          if (!opened || opened.torn) return;
          card.cursor = opened.cursor;
          if (serveEnabled && authority?.serve) {
            const ids = card.reader.nmlStorageIds();
            const urls = new Map(await Promise.all(ids.map(async (storageId) => [
              storageId,
              await convex.query(api.albums.url, {
                storageId: storageId as Id<"_storage">,
              }),
            ] as const)));
            if (cancelled) return;
            setRead(card.reader.blocks("nml", {
              resolveStorageUrl: (storageId) => urls.get(storageId) ?? undefined,
            }));
          } else {
            const blocks = card.reader.blocks("legacy");
            setRead(blocks);
            // Left behind for next time. Offered once: a viewer's offer is
            // declined, and asking again on every read would not change that.
            if (!offered.current) {
              offered.current = true;
              void convex
                .mutation(api.previews.set, {
                  docId,
                  blocks: encodePreview(blocks),
                  seq: card.cursor,
                })
                .catch(() => {});
            }
          }
        } catch {
          if (!cancelled) setRead([]);
        }
      })();
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, [yjs, docId, meta, convex, serveEnabled, authority]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const scale = useFit(box);

  // One element for all three states, rather than one each: it is what the
  // viewport gate observes and what the width is measured off, so it has to
  // exist before there is anything to draw in it.
  return (
    <div
      ref={box}
      aria-hidden="true"
      className={
        blocks === null
          ? // The sweep says a read is under way, and off-screen none is: a card
            // that has never come near kept an infinite animation, and the
            // compositor layer it runs on, for a page nobody was looking at.
            `nt-thumb nt-skeleton rounded-none${near ? "" : " is-still"}`
          : blocks.length
            ? "nt-thumb"
            : "nt-thumb is-empty"
      }
    >
      {!page ? null : page.length ? (
        // Hidden until measured, so the page is never seen at full size for a
        // frame before the transform lands.
        <div
          className="nt-thumb-page"
          style={{
            width: DOC_WIDTH,
            transform: `scale(${scale})`,
            visibility: scale ? "visible" : "hidden",
          }}
        >
          <PreviewBlocks blocks={page} />
        </div>
      ) : (
        <span className="nt-thumb-blank" />
      )}
    </div>
  );
}

/** How far a page laid out at `DOC_WIDTH` has to shrink to fit its box. */
function useFit(box: RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / DOC_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return scale;
}

/**
 * The thumbnail, from blocks already in hand rather than read from a document:
 * a page that does not exist yet, drawn the way it will look once it does.
 */
export function BlocksThumb({ blocks }: { blocks: readonly AnyBlock[] }) {
  const box = useRef<HTMLDivElement>(null);
  const scale = useFit(box);
  return (
    <div ref={box} aria-hidden="true" className="nt-thumb">
      <div
        className="nt-thumb-page"
        style={{
          width: DOC_WIDTH,
          transform: `scale(${scale})`,
          visibility: scale ? "visible" : "hidden",
        }}
      >
        <PreviewBlocks blocks={blocks.slice(0, MAX_BLOCKS)} />
      </div>
    </div>
  );
}

/**
 * The same picture, from blocks already in hand.
 *
 * First run draws a template this way before the project it describes exists,
 * so there is no document to read yet — only the blocks that are about to
 * become one. Sharing the renderer is the point: what the welcome screen shows
 * you and what the projects screen shows you afterwards are the same drawing
 * of the same page, which is what makes the promise land.
 */
export const PreviewBlocks = memo(function PreviewBlocks({
  blocks,
  diagramHeight,
}: {
  blocks: readonly AnyBlock[];
  /** Give a diagram its own height rather than the thumbnail's fixed one. */
  diagramHeight?: number;
}) {
  return (
    <>
      {blocks.map((block) => (
        <Block key={block.id} block={block} diagramHeight={diagramHeight} />
      ))}
    </>
  );
});

function Block({
  block,
  diagramHeight,
}: {
  block: AnyBlock;
  diagramHeight?: number;
}) {
  const props = block.props ?? {};

  switch (block.type) {
    case "heading": {
      const level = Number(props.level ?? 1);
      return (
        <p className="nt-thumb-h" data-level={level > 3 ? 3 : level}>
          <Inline content={block.content} />
        </p>
      );
    }

    case "bulletListItem":
    case "numberedListItem":
    case "checkListItem":
    case "toggleListItem":
      return (
        <>
          <p className="nt-thumb-li">
            <span className="nt-thumb-marker" />
            <span>
              <Inline content={block.content} />
            </span>
          </p>
          <Children blocks={block.children} />
        </>
      );

    case "quote":
      return (
        <p className="nt-thumb-quote">
          <Inline content={block.content} />
        </p>
      );

    case "codeBlock":
      // The real code surface, minus the highlighting — at this size a token
      // colour is a pixel, and the dark slab is what identifies the block.
      return <pre className="nt-thumb-code">{String(props.code ?? "")}</pre>;

    case "mathBlock":
      // One row per line, the way the block itself lays them out.
      return (
        <span className="nt-thumb-math">
          {String(props.source ?? "")
            .split("\n")
            .filter((line) => line.trim())
            .map((line, i) => (
              <ThumbMath key={i} latex={line} display />
            ))}
        </span>
      );

    case "canvas":
      /**
       * The slot holds the space; the renderer fills it when it arrives.
       *
       * `ThumbDiagram` is loaded on demand, so for the first beat this block is
       * absent from the DOM entirely — which moves everything under it when it
       * lands, and shifts the `nth-child` the stagger reads its delay from, so
       * the blocks below animate on the wrong beat and then jump. An element
       * that is there from the first paint with the right height fixes both.
       */
      return (
        <div
          className="nt-thumb-slot"
          style={diagramHeight ? { height: diagramHeight } : undefined}
        >
          <ThumbDiagram data={String(props.data ?? "")} />
        </div>
      );

    case "album": {
      // The first few, in a row. Not the waterfall in miniature: at this size
      // the packing is invisible and what identifies the block is that the page
      // has pictures on it. A video shows its poster, or the well behind it.
      const items = parseAlbum(String(props.data ?? "")).items.slice(0, 3);
      if (!items.length) return <span className="nt-thumb-media" />;
      return (
        <span className="nt-thumb-album">
          {items.map((item, i) => {
            const src = item.kind === "video" ? item.poster : item.src;
            return src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt="" style={{ aspectRatio: `${item.w} / ${item.h}` }} />
            ) : (
              <span key={i} />
            );
          })}
        </span>
      );
    }

    case "table":
      return <Table content={block.content} />;

    case "divider":
      return <hr className="nt-thumb-rule" />;

    case "image":
      return props.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="nt-thumb-img" src={String(props.url)} alt="" />
      ) : (
        <span className="nt-thumb-media" />
      );

    case "video":
    case "audio":
    case "file":
      return <span className="nt-thumb-media" />;

    case "location": {
      // The name is the whole of what a thumbnail can honestly say: the map is
      // an iframe and the photographs are a network away.
      const place = parseLocation(String(props.data ?? ""));
      return place.name ? (
        <p className="nt-thumb-p">{place.name}</p>
      ) : (
        <span className="nt-thumb-media" />
      );
    }

    case "notionStub":
      // A line, not a well: the card is one row tall on the page, and what
      // identifies it at this size is that a name sits where content did not.
      return <p className="nt-thumb-p">{describeStub(String(props.notionType ?? "")).label}</p>;

    default:
      return (
        <p className="nt-thumb-p">
          <Inline content={block.content} />
        </p>
      );
  }
}

/** Nested list items — an indented outline keeps its shape. */
function Children({ blocks }: { blocks?: AnyBlock[] }) {
  if (!blocks?.length) return null;
  return (
    <div className="nt-thumb-children">
      {blocks.map((b) => (
        <Block key={b.id} block={b} />
      ))}
    </div>
  );
}

type InlineItem = {
  type?: string;
  text?: string;
  href?: string;
  content?: unknown;
  styles?: Record<string, unknown>;
  props?: Record<string, unknown>;
};

/**
 * Inline content with its marks. Bold and italic are most of what gives a
 * paragraph its texture at this size, so they are worth carrying even though
 * the words themselves are past reading.
 */
function Inline({ content }: { content: unknown }) {
  if (!Array.isArray(content)) return null;
  return (
    <>
      {(content as InlineItem[]).map((item, i) => {
        if (item.type === "link") {
          return (
            <span key={i} className="nt-thumb-link">
              <Inline content={item.content} />
            </span>
          );
        }
        if (item.type === "math") {
          return <ThumbMath key={i} latex={String(item.props?.latex ?? "")} />;
        }
        // A box is its state, so at this size the state is the whole of it: a
        // glyph, not an `<input>`. Nothing on a thumbnail is pressable, and a
        // real control shrunk past reading reads as a smudge.
        if (item.type === "checkbox") {
          return (
            <span key={i} className="nt-thumb-check">
              {item.props?.checked ? "☑" : "☐"}
            </span>
          );
        }
        if (typeof item.text !== "string") return null;
        const s = item.styles ?? {};
        return (
          <span
            key={i}
            className={s.code ? "nt-thumb-inline-code" : undefined}
            style={{
              fontWeight: s.bold ? 600 : undefined,
              fontStyle: s.italic ? "italic" : undefined,
              textDecoration: s.underline
                ? "underline"
                : s.strike
                  ? "line-through"
                  : undefined,
            }}
          >
            {item.text}
          </span>
        );
      })}
    </>
  );
}

type TableContent = {
  rows?: Array<{ cells?: unknown[] }>;
  headerRows?: number;
};

function Table({ content }: { content: unknown }) {
  const table = content as TableContent | undefined;
  const rows = table?.rows ?? [];
  if (!rows.length) return <span className="nt-thumb-media" />;
  const headerRows = table?.headerRows ?? 0;

  return (
    <table className="nt-thumb-table">
      <tbody>
        {rows.slice(0, 8).map((row, r) => (
          <tr key={r}>
            {(row.cells ?? []).slice(0, 6).map((cell, c) => {
              const inner = Array.isArray(cell)
                ? cell
                : (cell as { content?: unknown })?.content;
              return r < headerRows ? (
                <th key={c}>
                  <Inline content={inner} />
                </th>
              ) : (
                <td key={c}>
                  <Inline content={inner} />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
