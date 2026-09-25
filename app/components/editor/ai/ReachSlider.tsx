"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAutocomplete } from "./useAutocomplete";
import "./reachSlider.css";

/** What the dial does where it stands — the halves are where behaviour changes. */
export function reachLine(reach: number): string {
  if (reach < 0.25) return "Only finishes the word or line you are on, and only with what the page already says.";
  if (reach < 0.5) return "Finishes what you start, and stays quiet when it would be guessing.";
  if (reach < 0.75) return "Continues your writing, and may offer code, math or a diagram.";
  return "Drafts what is not there yet — sections, diagrams, code.";
}

/** Autocomplete's mark — the bar's switch, and both ends of the dial. */
export const SPARK_PATH =
  "M12 3.5c.5 4.4 4.1 8 8.5 8.5-4.4.5-8 4.1-8.5 8.5-.5-4.4-4.1-8-8.5-8.5 4.4-.5 8-4.1 8.5-8.5Z";

/** The ends of the dial, as how much text it hands you: a line, or a paragraph. */
function Lines({ d }: { d: string }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
const LESS = "M4 10h16M4 15h10";
const MORE = "M4 4h16M4 9.33h16M4 14.67h16M4 20h10";

/** Long enough to be the end of a drag, short enough to feel saved. */
const SAVE_MS = 250;

/**
 * How much autocomplete writes, less to more. One control, drawn in the
 * two places it is reached from: the bar button's popover and ⌘K.
 */
export function ReachSlider({ autoFocus = false }: { autoFocus?: boolean }) {
  const id = useId();
  const { on, reach, setReach } = useAutocomplete();
  /** The thumb while it is moving, ahead of the write that settles it. */
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const value = draft ?? reach;

  const move = (next: number) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setReach(next);
      setDraft(null);
    }, SAVE_MS);
  };

  return (
    <div className="nt-reach">
      <label htmlFor={id} className="nt-reach-name">
        How much autocomplete writes
        {!on && <span className="nt-reach-off">Off</span>}
      </label>
      <div className="nt-reach-track">
        <Lines d={LESS} />
        <input
          id={id}
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => move(Number(e.target.value))}
          aria-valuetext={reachLine(value)}
          className="nt-reach-range"
        />
        <Lines d={MORE} />
      </div>
      <p className="nt-reach-line">{reachLine(value)}</p>
    </div>
  );
}

/**
 * The slider over the bar button that raised it — a right-click on the
 * switch. Grows up out of the bar, which sits at the foot of the page.
 */
export function ReachPopover({
  anchor,
  onClose,
}: {
  anchor: DOMRect;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.left);

  // Centred on the button, then folded back inside the viewport.
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    const centred = anchor.left + anchor.width / 2 - w / 2;
    setLeft(Math.min(Math.max(8, centred), Math.max(8, window.innerWidth - w - 8)));
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div
        className="fixed inset-0"
        style={{ zIndex: "var(--z-popover)" }}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="dialog"
        aria-label="How much autocomplete writes"
        className="nt-menu nt-reach-pop fixed"
        style={
          {
            bottom: window.innerHeight - anchor.top + 8,
            left,
            "--origin": "bottom center",
          } as React.CSSProperties
        }
      >
        <ReachSlider autoFocus />
      </div>
    </>,
    document.body,
  );
}
