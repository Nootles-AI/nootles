"use client";

import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "@/app/components/Icons";
import { Note } from "./Markdown";
import {
  groupLine,
  isFailed,
  isRunning,
  stepLine,
  summaryLine,
  type Family,
  type TraceItem,
} from "./steps";

/**
 * The work behind an answer, as a thread of beads.
 *
 * A turn is two things of different weight: what the agent did, and what it
 * says. The saying is the document's voice, full ink, below. The doing is a
 * record — a rail down the gutter with one bead per act, a glyph saying what
 * kind of act, and a line saying what it came to. While the turn runs the
 * thread draws itself, bead by bead, and the one step still going glows the
 * amber that means the AI is at work. Once the answer has landed the thread
 * folds to a single line, because the answer is what was asked for; the work
 * is there for whoever wants to see how it was reached.
 */
export const Trace = memo(function Trace({
  trace,
  live,
  foldable,
}: {
  trace: TraceItem[];
  /** The turn is still being written. */
  live: boolean;
  /** An answer has landed below, so the work may step aside for it. */
  foldable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const body = useId();
  if (!trace.length) return null;
  const folded = foldable && !live;
  const shown = !folded || open;
  const summary = summaryLine(trace);

  return (
    <div className={`nt-trace${folded ? " is-folded" : ""}`}>
      {folded && (
        <button
          type="button"
          className={`nt-trace-fold${open ? " is-open" : ""}`}
          aria-expanded={open}
          aria-controls={body}
          title={summary}
          onClick={() => setOpen((was) => !was)}
        >
          <ChevronRight className="nt-trace-chevron" aria-hidden />
          <span className="nt-trace-summary">{summary}</span>
        </button>
      )}
      <div id={body} className={`nt-trace-body${shown ? " is-open" : ""}`} inert={!shown}>
        <ol className="nt-trace-list" aria-label="What the agent did">
          {trace.map((item) =>
            item.kind === "note" ? (
              <NoteItem key={item.key} text={item.text} streaming={item.streaming} live={live} />
            ) : (
              <StepItem key={item.key} item={item} />
            ),
          )}
        </ol>
      </div>
    </div>
  );
});

/**
 * A thought, on the thread with the acts it led to. Shown whole — the thinking
 * is the part of the work worth reading in full — and set down the way it is
 * being had: a provider hands reasoning over in lumps, often a whole paragraph
 * at once, so the words are let out at a writing pace instead of appearing.
 * Only a thought that arrives while it is being watched is written out; one
 * read back from a finished thread is simply there.
 */
function NoteItem({ text, streaming, live }: { text: string; streaming: boolean; live: boolean }) {
  const shown = useArriving(text, live);
  return (
    <li className={`nt-trace-item is-note${streaming ? " is-running" : ""}`}>
      <span className="nt-bead" aria-hidden>
        <Glyph family="think" />
      </span>
      <div className="nt-trace-note">
        <Note text={shown} />
      </div>
    </li>
  );
}

/**
 * `text` let out a little at a time. The pace follows how far behind the
 * reveal is — a paragraph that lands at once is written out in well under a
 * second, the last few words ease in — and it stops at a word, so nothing is
 * ever shown half-spelt.
 */
function useArriving(text: string, animate: boolean): string {
  const [shown, setShown] = useState(() => (animate ? 0 : text.length));
  const at = useRef(shown);

  useEffect(() => {
    if (at.current >= text.length) {
      at.current = text.length;
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const behind = text.length - at.current;
      const rate = Math.max(MIN_PACE, behind * CATCH_UP);
      at.current = Math.min(text.length, at.current + Math.max(1, (rate * (now - last)) / 1000));
      last = now;
      setShown(Math.floor(at.current));
      if (at.current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);

  if (shown >= text.length) return text;
  const cut = text.lastIndexOf(" ", shown);
  return text.slice(0, cut > 0 ? cut : shown);
}

/** Characters a second at the least, so the tail of a thought never dawdles. */
const MIN_PACE = 80;
/** How fast the reveal closes on what has arrived: the share of the gap covered in a second. */
const CATCH_UP = 3;

function StepItem({ item }: { item: Extract<TraceItem, { kind: "step" }> }) {
  const [open, setOpen] = useState(false);
  const detail = useId();
  const running = item.parts.some(isRunning);
  const failed = item.parts.every(isFailed);
  const many = item.parts.length > 1;
  const line = groupLine(item.tool, item.parts);

  return (
    <li
      className={`nt-trace-item is-step is-${item.family}${running ? " is-running" : ""}${
        failed ? " is-failed" : ""
      }`}
    >
      <span className="nt-bead" aria-hidden>
        <Glyph family={item.family} />
      </span>
      <div className="nt-trace-step">
        {many ? (
          <button
            type="button"
            className={`nt-trace-label is-toggle${open ? " is-open" : ""}`}
            aria-expanded={open}
            aria-controls={detail}
            onClick={() => setOpen((was) => !was)}
          >
            <span>{line}</span>
            <ChevronRight className="nt-trace-chevron" aria-hidden />
          </button>
        ) : (
          <p className="nt-trace-label">{line}</p>
        )}
        {many && (
          <div id={detail} className={`nt-trace-detail${open ? " is-open" : ""}`} inert={!open}>
            <ul>
              {item.parts.map((part) => (
                <li key={part.toolCallId} className={isFailed(part) ? "is-failed" : undefined}>
                  {stepLine(part)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * One glyph per kind of act, drawn on the house icon grid (24 units, round
 * 2px strokes) so the rail reads as part of the same set as the sidebar.
 */
function Glyph({ family }: { family: Family }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[family]}
    </svg>
  );
}

const GLYPHS: Record<Family, ReactNode> = {
  // A brain: the agent thinking.
  think: (
    <>
      <path d="M12 5.5a3 3 0 0 0-5.6-1.3A3.2 3.2 0 0 0 3.8 9a3.2 3.2 0 0 0 .5 5.5A3.3 3.3 0 0 0 7.5 19a2.8 2.8 0 0 0 4.5.8" />
      <path d="M12 5.5a3 3 0 0 1 5.6-1.3A3.2 3.2 0 0 1 20.2 9a3.2 3.2 0 0 1-.5 5.5 3.3 3.3 0 0 1-3.2 4.5 2.8 2.8 0 0 1-4.5.8" />
      <path d="M12 5.5v14.3M8 10.5c1 .9 2.4.9 3.4 0M16 13.5c-1-.9-2.4-.9-3.4 0" />
    </>
  ),
  // A lens: looking for something.
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.8-4.8" />
    </>
  ),
  // A globe: looking beyond the project.
  web: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  // A page with its lines: reading.
  read: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  // A node reaching two others: following the graph.
  graph: (
    <>
      <circle cx="5.5" cy="12" r="2.5" />
      <circle cx="18.5" cy="5.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
      <path d="m7.8 10.8 8.4-4.1M7.8 13.2l8.4 4.1" />
    </>
  ),
  // A pen: the writer drafting.
  write: (
    <>
      <path d="M12 20h8" />
      <path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4Z" />
    </>
  ),
  // Lines taking a new one: placing into the page.
  place: (
    <>
      <path d="M4 5h16M4 19h16M4 12h8" />
      <path d="m16 9 3 3-3 3" />
    </>
  ),
  // A page: the project's pages.
  page: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  // A speech mark: the page's discussion.
  comment: <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.4A7.5 7.5 0 1 1 20 11.5Z" />,
  // A brush: the illustrator at work.
  draw: (
    <>
      <path d="M19.4 3.6a2 2 0 0 1 2.9 2.9L13 15.9l-3-2.9Z" />
      <path d="M9.7 14.4c-2.2-.3-4.4 1.2-4.4 3.8 0 1.2-.8 2.3-2.3 2.3 1.4 1.4 3.2 1.5 4.6 1.5 2.9 0 4.9-2.1 4.9-4.6" />
    </>
  ),
  // Two shapes: working on a diagram.
  canvas: (
    <>
      <rect x="3" y="3" width="9" height="9" rx="2" />
      <circle cx="16.5" cy="16.5" r="4.5" />
    </>
  ),
  // A note on a stave: songs, pictures, the album.
  media: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  // An eye: looking closely at pictures.
  look: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  // A pin: finding places.
  map: (
    <>
      <path d="M19.5 10c0 5.5-7.5 11.5-7.5 11.5S4.5 15.5 4.5 10a7.5 7.5 0 0 1 15 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  // Anything else: a plain mark.
  tool: <circle cx="12" cy="12" r="3.5" />,
};
