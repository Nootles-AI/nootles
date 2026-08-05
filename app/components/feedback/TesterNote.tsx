"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Id } from "@/convex/_generated/dataModel";
import { useHints } from "../hints/useHints";
import { Info } from "../Icons";
import "./letter.css";

/**
 * A letter from the founder, shown once — in the first project that is the
 * user's own rather than the seeded tutorial.
 *
 * A sheet of paper over a blurred room, with a drawn arrow running from the
 * sheet's edge to the one thing it asks for: the report button, lifted out of
 * the blur and ringed so there is no doubt which button is meant. It never
 * comes back: dismissal is recorded in the same seen-set the hints use.
 *
 * Portalled to the body: the workspace tree carries transforms, and a fixed
 * scrim inside one is contained by it — which quietly turns its backdrop
 * blur into a no-op.
 */
export function TesterNote({ projectId }: { projectId: Id<"projects"> }) {
  const { profile, die } = useHints();

  const own =
    profile != null &&
    profile.status !== "surveying" &&
    profile.seed?.projectId !== projectId;
  const unread = own && !(profile.hints ?? []).includes("tester-note");

  if (!unread) return null;
  return createPortal(<Letter onClose={() => die("tester-note")} />, document.body);
}

/** Where the report button lives (`.nt-feedback`): left 20, bottom 20, 32px. */
const FAB = { cx: 36, bottom: 20, size: 32 };

function Letter({ onClose }: { onClose: () => void }) {
  // The letter ends in handwriting; until the file loads, it ends in type.
  const [signed, setSigned] = useState(true);
  const sheetRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const [path, setPath] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    // Following the arrow is the best possible way to close the letter — a
    // press on the ringed button counts as "will do", and the report form it
    // morphs into deserves the screen to itself.
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element).closest("[data-nt-feedback]")) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  /**
   * The arrow, measured rather than guessed: from just under the sheet's
   * lower-left corner, down the room, into the button. Rebuilt on resize so
   * it never points at where the letter used to be.
   */
  const draw = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const r = sheet.getBoundingClientRect();
    const sx = r.left + 34;
    const sy = r.bottom + 6;
    // The tip stops just short of the ring, approaching from above-right.
    const ex = FAB.cx + 18;
    const ey = window.innerHeight - FAB.bottom - FAB.size - 16;
    const dx = sx - ex;
    const dy = ey - sy;
    // One long stroke with a lazy S in it — a pen's line, not a plotter's.
    const c1 = { x: sx + dx * 0.06, y: sy + dy * 0.62 };
    const c2 = { x: ex + Math.min(120, dx * 0.5), y: ey - Math.max(60, dy * 0.18) };
    // The head follows the stroke's landing direction.
    const a = Math.atan2(ey - c2.y, ex - c2.x);
    const head = (spread: number) => ({
      x: ex - 16 * Math.cos(a + spread),
      y: ey - 16 * Math.sin(a + spread),
    });
    const h1 = head(0.5);
    const h2 = head(-0.5);
    setPath(
      `M ${sx} ${sy} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${ex} ${ey} ` +
        `M ${h1.x} ${h1.y} L ${ex} ${ey} L ${h2.x} ${h2.y}`,
    );
  }, []);

  useLayoutEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  // Drawn in like a stroke landing: dash the path to its own length, then let
  // the transition carry it to zero. Skipped under reduced motion.
  useLayoutEffect(() => {
    const el = pathRef.current;
    if (!el || !path) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // A resize rebuilds the path; the old dash pattern on a new length would
    // punch gaps in the stroke, so once drawn the dash comes off entirely.
    if (el.dataset.drawn) {
      el.style.strokeDasharray = "";
      el.style.strokeDashoffset = "";
      return;
    }
    el.dataset.drawn = "1";
    const length = el.getTotalLength();
    el.style.strokeDasharray = `${length}`;
    el.style.strokeDashoffset = `${length}`;
    requestAnimationFrame(() => {
      el.style.transition = "stroke-dashoffset 0.8s var(--ease) 0.3s";
      el.style.strokeDashoffset = "0";
    });
  }, [path]);

  return (
    <>
      <button aria-label="Close" onClick={onClose} className="nt-letter-scrim" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="A personal thank you"
        className="nt-letter"
      >
        <p className="text-[17px] font-semibold tracking-[-0.01em]">
          A personal thank you
        </p>
        <div className="mt-3.5 space-y-3.5 text-sm leading-relaxed text-muted">
          <p>Thank you for being one of Nootles&rsquo; first test users.</p>
          <p>
            If anything breaks — or you find yourself wishing for something that
            isn&rsquo;t there — press the{" "}
            <span className="mx-0.5 inline-flex h-[19px] w-[19px] translate-y-[3px] items-center justify-center rounded-full border border-border text-foreground">
              <Info width={12} height={12} />
            </span>{" "}
            button in the bottom-left corner. It takes bug reports and feature
            requests alike.
          </p>
          <p>
            I go through every report myself, and you&rsquo;ll be notified when
            yours has been fixed.
          </p>
          <p>
            As thanks for helping improve Nootles: report a real bug, and your
            access is free for life.
          </p>
        </div>

        <div className="mt-5 flex items-end justify-between gap-3">
          {signed ? (
            /* eslint-disable-next-line @next/next/no-img-element -- a small
               static asset with no layout shift to optimize away */
            <img
              src="/signature.png"
              alt="Ali"
              className="h-12 w-auto"
              onError={() => setSigned(false)}
            />
          ) : (
            <p className="text-sm text-foreground">— Ali</p>
          )}
          <button onClick={onClose} className="nt-row px-2.5 font-medium">
            Will do
          </button>
        </div>
      </div>

      <svg className="nt-letter-arrow" aria-hidden>
        <path
          ref={pathRef}
          d={path}
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </>
  );
}
