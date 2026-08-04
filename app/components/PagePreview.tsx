"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/** A page reduced to the little of it a thumbnail can show. */
export type PreviewLine = { type: string; text: string };

/** Enough to fill the tallest card; the rest is below the crop anyway. */
const MAX_LINES = 14;
const MAX_CHARS = 120;

/**
 * A project's first page, drawn small enough to recognise but not to read.
 *
 * Read on the CLIENT, and that is the whole point of the arrangement. The
 * server can reach a page's snapshot but not its document: snapshots are
 * written on a debounce that is dropped whenever the server runs ahead, so a
 * page can sit for good with edits that exist only as steps. Replaying them
 * needs `Step.fromJSON` against the BlockNote schema — a browser bundle. Reading
 * the snapshot alone is what made every one of these come back empty.
 *
 * `blocksFromSnapshot` is the same reader the chat's `read_page` uses, so a
 * thumbnail and the AI see one document.
 *
 * `aria-hidden` because it is a picture of content the card already names. A
 * screen reader reading fourteen sentence fragments in 8px type would be
 * getting the decoration and missing the label. It also settles the contrast
 * question: nothing here is text to be read.
 */
export function PagePreview({ docId }: { docId: string | null }) {
  const snapshot = useQuery(
    api.prosemirror.getSnapshot,
    docId ? { id: docId } : "skip",
  );
  // The steps taken since that snapshot are the rest of the document.
  const since = useQuery(
    api.prosemirror.getSteps,
    snapshot?.content ? { id: docId!, version: snapshot.version } : "skip",
  );

  const [lines, setLines] = useState<PreviewLine[] | null>(null);

  /*
   * BlockNote is the heaviest thing in the app and the projects screen has no
   * other use for it, so it is imported on demand rather than bundled into this
   * route. That makes the projection asynchronous, which is why it lands in
   * state instead of being derived during render — the effect is doing real
   * async work, not restating a prop.
   */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (snapshot === undefined) return; // still loading
    if (!snapshot?.content) {
      setLines([]);
      return;
    }
    if (since === undefined) return; // steps still loading

    let cancelled = false;
    void (async () => {
      const [{ blocksFromSnapshot }, { flattenBlocks }] = await Promise.all([
        import("@/app/lib/ai/snapshot"),
        import("@/app/lib/ai/projection"),
      ]);
      if (cancelled) return;
      let next: PreviewLine[] = [];
      try {
        const blocks = blocksFromSnapshot(snapshot.content, since.steps);
        next = flattenBlocks(blocks)
          .slice(0, MAX_LINES)
          .map((b) => ({
            type: b.type,
            text: b.text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS),
          }));
      } catch {
        // A document the reader cannot rebuild is a blank card, not a blank
        // screen. Nothing here is worth failing the projects list over.
        next = [];
      }
      // A trailing empty paragraph is what the editor leaves under everything
      // you wrote; it is not a line of the document.
      while (next.length && next[next.length - 1].type === "paragraph" && !next[next.length - 1].text) {
        next.pop();
      }
      setLines(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot, since]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (lines === null) {
    return <div className="nt-thumb nt-skeleton rounded-none" aria-hidden="true" />;
  }

  if (!lines.length) {
    return (
      <div className="nt-thumb is-empty" aria-hidden="true">
        <span className="nt-thumb-blank" />
      </div>
    );
  }

  return (
    <div className="nt-thumb" aria-hidden="true">
      {lines.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </div>
  );
}

/**
 * One block. The void kinds — a diagram, an image, a divider — have no words,
 * so they are drawn as the space they occupy, which is what they look like from
 * across the room.
 */
function Line({ line }: { line: PreviewLine }) {
  switch (line.type) {
    case "heading":
      return <p className="nt-thumb-h">{line.text}</p>;

    case "bulletListItem":
    case "numberedListItem":
    case "checkListItem":
    case "toggleListItem":
      return (
        <p className="nt-thumb-li">
          <span className="nt-thumb-marker" />
          {line.text}
        </p>
      );

    case "quote":
      return <p className="nt-thumb-quote">{line.text}</p>;

    case "codeBlock":
    case "mathBlock":
      return <p className="nt-thumb-code">{line.text}</p>;

    case "canvas":
      return <span className="nt-thumb-canvas" />;

    case "table":
      return <span className="nt-thumb-table" />;

    case "divider":
      return <span className="nt-thumb-rule" />;

    case "image":
    case "video":
    case "audio":
    case "file":
      return <span className="nt-thumb-media" />;

    default:
      // A paragraph with nothing in it is a blank line in the document, and a
      // blank line is part of the shape — it keeps the rhythm honest.
      return line.text ? (
        <p className="nt-thumb-p">{line.text}</p>
      ) : (
        <span className="nt-thumb-gap" />
      );
  }
}
