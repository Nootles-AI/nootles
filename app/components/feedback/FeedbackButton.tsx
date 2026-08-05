"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { Id } from "@/convex/_generated/dataModel";
import { SpeechBubble } from "../Icons";

const FeedbackPanel = dynamic(
  () => import("./FeedbackPanel").then((m) => m.FeedbackPanel),
  { ssr: false },
);

/** The standing invitation, bottom-right: report an issue or make a wish. */
export function FeedbackButton({
  projectId,
  pageId,
}: {
  projectId: Id<"projects">;
  pageId?: Id<"pages"> | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {open && (
        <FeedbackPanel
          projectId={projectId}
          pageId={pageId ?? null}
          onClose={() => setOpen(false)}
        />
      )}
      <button
        className="nt-feedback-btn nt-tip is-up"
        data-tip="Report an issue or make a wish"
        aria-label="Send feedback"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SpeechBubble />
      </button>
    </>
  );
}
