"use client";

import { useEffect, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { useHints } from "../hints/useHints";
import { Info } from "../Icons";
import "./letter.css";

/**
 * A letter from the founder, shown once — in the first project that is the
 * user's own rather than the seeded tutorial.
 *
 * A sheet of paper over a blurred room, with a drawn arrow to the one thing
 * it asks for: the report button, lifted out of the blur and ringed so there
 * is no doubt which button is meant. It never comes back: dismissal is
 * recorded in the same seen-set the first-touch hints use.
 */
export function TesterNote({ projectId }: { projectId: Id<"projects"> }) {
  const { profile, die } = useHints();

  const own =
    profile != null &&
    profile.status !== "surveying" &&
    profile.seed?.projectId !== projectId;
  const unread = own && !(profile.hints ?? []).includes("tester-note");

  if (!unread) return null;
  return <Letter onClose={() => die("tester-note")} />;
}

function Letter({ onClose }: { onClose: () => void }) {
  // The letter ends in handwriting; until the file loads, it ends in type.
  const [signed, setSigned] = useState(true);

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

  return (
    <>
      <button
        aria-label="Close"
        onClick={onClose}
        className="nt-letter-scrim"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="A personal thank you"
        className="nt-letter"
      >
        <p className="text-[15px] font-semibold tracking-[-0.01em]">
          A personal thank you
        </p>
        <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-muted">
          <p>Thank you for being one of Nootles&rsquo; first test users.</p>
          <p>
            If anything breaks — or you find yourself wishing for something that
            isn&rsquo;t there — press the{" "}
            <span className="mx-0.5 inline-flex h-[18px] w-[18px] translate-y-[3px] items-center justify-center rounded-full border border-border text-foreground">
              <Info width={11} height={11} />
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

        <div className="mt-4 flex items-end justify-between gap-3">
          {signed ? (
            /* eslint-disable-next-line @next/next/no-img-element -- a small
               static asset with no layout shift to optimize away */
            <img
              src="/signature.png"
              alt="Ali"
              className="h-11 w-auto"
              onError={() => setSigned(false)}
            />
          ) : (
            <p className="text-[13px] text-foreground">— Ali</p>
          )}
          <button onClick={onClose} autoFocus className="nt-row px-2.5 font-medium">
            Will do
          </button>
        </div>
      </div>

      {/* Drawn from the letter's side of the room down to the button. One
          wobbling stroke and an open head — a pen's arrow, not a plotter's. */}
      <svg
        className="nt-letter-arrow"
        width="150"
        height="190"
        viewBox="0 0 150 190"
        fill="none"
        aria-hidden
      >
        <path
          d="M138 14c-4 34-10 66-30 96-15 23-38 42-72 54m0 0c9-1 20-1 30 2m-30-2c7-6 14-14 18-24"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}
