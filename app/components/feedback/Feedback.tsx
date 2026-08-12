"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { FeedbackPanel } from "./FeedbackPanel";
import { Info } from "../Icons";

/**
 * The standing invitation, bottom-left. One fixed container that IS both
 * states: a 32px circle when closed, the report form when open — width,
 * height and radius transition between them, so the circle morphs into the
 * form rather than being replaced by it.
 *
 * The morph is kept smooth by doing nothing else during it: the form mounts
 * before the transition starts (statically imported — its one heavy
 * dependency, html-to-image, is lazy inside the panel), the height is set
 * imperatively in a layout effect so the first open frame already carries
 * the target size, and the screenshot + focus wait until the box has landed.
 */
export function Feedback({
  projectId,
  pageId,
}: {
  /** Absent on the projects screen, which has no project open. */
  projectId?: Id<"projects">;
  pageId?: Id<"pages"> | null;
}) {
  const [open, setOpen] = useState(false);
  // The form outlives `open` by one transition, so closing shows the panel
  // shrinking back into the circle instead of a box emptying first.
  const [rendered, setRendered] = useState(false);
  // Bumped per open, so every open starts a fresh form (and screenshot).
  const [session, setSession] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const openUp = () => {
    setSession((s) => s + 1);
    setRendered(true);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    // Back to the stylesheet's 32px; the removal is what animates the shrink.
    if (boxRef.current) boxRef.current.style.height = "";
  };

  // Height is driven imperatively, before paint, so the first open frame
  // already carries the target size — width and height travel together
  // instead of the box widening and then lurching taller.
  useLayoutEffect(() => {
    if (!open) return;
    const box = boxRef.current;
    const body = bodyRef.current;
    if (!box || !body) return;
    const fit = () => {
      box.style.height = `${body.offsetHeight}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(body);
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
