"use client";

import { useEffect, useRef, type ReactNode } from "react";
import "./notion.css";

/** The heading every palette page names itself by. */
export const PALETTE_TITLE_ID = "nt-notion-title";

/**
 * The same frame in the palette's dress: no box of its own, a head that is only
 * there when a state has something to say, and the palette's footer. It keeps
 * `Shell`'s one promise — the status region stays mounted across every state.
 */
export function PaletteShell({
  said,
  title,
  note,
  bar,
  flush,
  children,
  foot,
}: {
  said: string;
  title: string;
  /** Children run to the edges: they are panes, not a padded body. */
  flush?: boolean;
  note?: string;
  bar?: ReactNode;
  children?: ReactNode;
  foot: ReactNode;
}) {
  // Stepping onto this page unmounts the palette's field, and with it whatever
  // had focus. A state with nothing of its own to focus — asking, reading —
  // would leave the keyboard on the document, where Escape closes the palette
  // instead of stepping back. The page itself takes it until something better
  // arrives.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={root} tabIndex={-1} className="nt-pal-form nt-pal-notion outline-none">
      <p className="sr-only" role="status">
        {said}
      </p>
      {(title || note || bar) && (
        <div className="nt-pal-nhead">
          {title && (
            <h2 id={PALETTE_TITLE_ID} className="nt-pal-ntitle">
              {title}
            </h2>
          )}
          {note && <p className="nt-pal-nnote">{note}</p>}
          {bar}
        </div>
      )}
      <div className={`nt-notion-body nt-pal-nbody${flush ? " is-flush" : ""}`}>{children}</div>
      <div className="nt-pal-foot">{foot}</div>
    </div>
  );
}
