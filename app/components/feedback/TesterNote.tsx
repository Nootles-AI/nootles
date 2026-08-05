"use client";

import { useEffect, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { useHints } from "../hints/useHints";
import { Info } from "../Icons";

/**
 * A note from the founder, shown once — in the first project that is the
 * user's own rather than the seeded tutorial.
 *
 * A modal, deliberately: this is a letter, not a lesson, and the one thing it
 * asks — use the report button — is worth a moment of full attention. It
 * never comes back: dismissal is recorded in the same seen-set the hints use.
 */
export function TesterNote({ projectId }: { projectId: Id<"projects"> }) {
  const { profile, die } = useHints();

  const own =
    profile != null &&
    profile.status !== "surveying" &&
    profile.seed?.projectId !== projectId;
  const unread = own && !(profile.hints ?? []).includes("tester-note");

  if (!unread) return null;
  return <Note onClose={() => die("tester-note")} />;
}

function Note({ onClose }: { onClose: () => void }) {
  // The letter ends in handwriting; until the file is there, it ends in type.
  const [signed, setSigned] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-foreground/15"
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="A note from Ali"
        className="nt-menu fixed left-1/2 top-1/4 w-[24rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5"
        style={{ zIndex: "var(--z-modal)" }}
      >
        <p className="text-sm font-medium">
          Thank you for being one of Nootles&rsquo; first test users.
        </p>
        <div className="mt-3 space-y-3 text-[13px] leading-relaxed text-muted">
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
    </>
  );
}
