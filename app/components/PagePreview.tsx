"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { parseAlbum } from "@/app/components/editor/album/parse";
import type { AnyBlock } from "@/app/lib/ai/projection";

/**
 * The width the document is written at — `--measure`. The thumbnail lays out at
 * exactly this and is then scaled into the card, so line breaks, heading sizes
 * and diagram geometry are the document's own rather than a small-screen
 * reflow of it. That is what makes this read as a picture of the page instead
 * of a narrow copy of it.
 */
const DOC_WIDTH = 600;

/** Past this nothing is above the crop, even on the tallest card. */
const MAX_BLOCKS = 18;

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
export function PagePreview({ docId }: { docId: string | null }) {
  const snapshot = useQuery(
    api.prosemirror.getSnapshot,
    docId ? { id: docId } : "skip",
  );
  const since = useQuery(
    api.prosemirror.getSteps,
    snapshot?.content ? { id: docId!, version: snapshot.version } : "skip",
  );

  const [blocks, setBlocks] = useState<AnyBlock[] | null>(null);

  /*
   * BlockNote is the heaviest thing in the app and this route has no other use
   * for it, so it is imported on demand. That makes the read asynchronous,
   * which is why it lands in state rather than being derived during render —
   * the effect is doing real work, not restating a prop.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (snapshot === undefined) return;
    if (!snapshot?.content) {
      setBlocks([]);
      return;
    }
    if (since === undefined) return;

    let cancelled = false;
    void (async () => {
      const { blocksFromSnapshot } = await import("@/app/lib/ai/snapshot");
      if (cancelled) return;
      try {
        setBlocks(blocksFromSnapshot(snapshot.content, since.steps));
      } catch {
        // A document the reader cannot rebuild is a blank card, not a blank
        // screen. Nothing here is worth failing the projects list over.
        setBlocks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, since]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The card is fluid, so the shrink factor is measured rather than assumed.
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / DOC_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // Depends on `blocks` because the measured element does not exist until
    // they arrive — the skeleton and the empty state render a different box.
    // With an empty dependency list this runs once against a null ref, and the
    // page stays hidden for good.
  }, [blocks]);

  if (blocks === null) {
    return <div className="nt-thumb nt-skeleton rounded-none" aria-hidden="true" />;
  }

  if (!blocks.length) {
    return (
      <div className="nt-thumb is-empty" aria-hidden="true">
        <span className="nt-thumb-blank" />
      </div>
    );
  }

  return (
    <div ref={box} className="nt-thumb" aria-hidden="true">
      {/* Hidden until measured, so the page is never seen at full size for a
          frame before the transform lands. */}
      <div
        className="nt-thumb-page"
        style={{
          width: DOC_WIDTH,
          transform: `scale(${scale})`,
          visibility: scale ? "visible" : "hidden",
        }}
      >
        {blocks.slice(0, MAX_BLOCKS).map((block) => (
          <Block key={block.id} block={block} />
        ))}
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
export function PreviewBlocks({
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
}

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
