"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Id } from "@/convex/_generated/dataModel";
import { Info } from "../Icons";

const FeedbackPanel = dynamic(
  () => import("./FeedbackPanel").then((m) => m.FeedbackPanel),
  { ssr: false },
);

const CLOSED = 32;

/**
 * The standing invitation, bottom-right. One fixed container that IS both
 * states: a 32px circle when closed, the report form when open — width,
 * height and radius transition between them, so the circle morphs into the
 * form rather than being replaced by it.
 */
export function Feedback({
  projectId,
  pageId,
}: {
  projectId: Id<"projects">;
  pageId?: Id<"pages"> | null;
}) {
  const [open, setOpen] = useState(false);
  // The form outlives `open` by one transition, so closing shows the panel
  // shrinking back into the circle instead of a box emptying first.
  const [rendered, setRendered] = useState(false);
  // Bumped per open, so every open starts a fresh form (and screenshot).
  const [session, setSession] = useState(0);
  const [height, setHeight] = useState(CLOSED);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const openUp = () => {
    setSession((s) => s + 1);
    setRendered(true);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setHeight(CLOSED);
  };

  // The container follows the form's measured height — the observer fires on
  // observe, when the dynamic chunk lands, and when the sent state swaps in.
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, session]);

  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setRendered(false), 400);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={boxRef}
      className={`nt-feedback${open ? " is-open" : ""}`}
      style={{ height }}
      data-nt-feedback
    >
      <button
        className="nt-feedback-fab"
        aria-label="Report a bug or request a feature"
        aria-expanded={open}
        tabIndex={open ? -1 : 0}
        onClick={openUp}
      >
        <Info />
      </button>
      {rendered && (
        <div ref={bodyRef} className="nt-feedback-body" aria-hidden={!open}>
          <FeedbackPanel
            key={session}
            projectId={projectId}
            pageId={pageId ?? null}
            onClose={close}
          />
        </div>
      )}
    </div>
  );
}
