import type { TemplateId } from "@/app/lib/onboarding/types";

/**
 * A mark per kind of document.
 *
 * Drawn in the app's own icon system — 24 viewBox, round caps, currentColor —
 * but at a lighter weight than the chrome uses. The icons in the shell are
 * controls and have to hold their own next to a label; these name a category
 * the label has already named, so they read as watermarks rather than as
 * buttons. Stroke 1.5 at 14px lands around 0.9 of a pixel, which is the point
 * where a line stops asking to be looked at.
 *
 * Two shapes each, at most. Anything with more detail turns to grey mush at
 * this size, and a mark nobody can resolve is worse than no mark.
 */
const MARKS: Record<TemplateId, React.ReactNode> = {
  // What is being aimed at, and the open questions around it.
  prd: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  // The topology itself: one box above, two below, joined.
  techDesign: (
    <>
      <rect x="9" y="3" width="6" height="5" rx="1.5" />
      <rect x="2.5" y="16" width="6" height="5" rx="1.5" />
      <rect x="15.5" y="16" width="6" height="5" rx="1.5" />
      <path d="M12 8v3.5M5.5 16v-2.5h13V16" />
    </>
  ),
  // Finding out.
  research: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.6 4.6" />
    </>
  ),
  // Ruled lines, the last one short — a page with writing on it.
  classNotes: <path d="M5 7h14M5 12h14M5 17h8" />,
  // A strip of frames.
  screenplay: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M9 6v12M15 6v12" />
    </>
  ),
  // A drafting square.
  woodworking: <path d="M5 4v16h16z" />,
};

export function TemplateMark({ id }: { id: TemplateId }) {
  return (
    <svg
      className="nt-wc-mark-icon"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {MARKS[id]}
    </svg>
  );
}
