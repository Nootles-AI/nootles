"use client";

import type { Rect } from "./useRect";

const WIDTH = 296;
const GAP = 12;
const EDGE = 16;

/**
 * What to do, beside the thing to do it to.
 *
 * Deliberately colourless. The accent in this app means one thing — the model
 * is doing something — and every gated step here is pointing AT that, so the
 * amber is already on screen where it belongs: in the streaming head, in the
 * ghost text, in the suggestion chip. A card that also wore it would be the
 * second voice saying the same word, and the word would stop meaning anything.
 */
export function CoachCard({
  rect,
  step,
  total,
  title,
  action,
  hint,
  onNext,
  onSkip,
}: {
  rect: Rect | null;
  step: number;
  total: number;
  title: string;
  action: string;
  hint?: string;
  onNext: () => void;
  onSkip: () => void;
}) {
  const place = position(rect);
  return (
    <div className="nt-tour-card" style={place.style} role="status">
      <p className="nt-tour-card-title">{title}</p>
      <p className="nt-tour-card-action">
        {action}
        {hint && <kbd className="nt-tour-key">{hint}</kbd>}
      </p>
      <div className="nt-tour-card-foot">
        <span className="nt-tour-step">
          {step} of {total}
        </span>
        {/* A step can always be stepped past. Partly because a guide that can
            only be finished or abandoned is a modal wearing a disguise — and
            partly because the last beat waits on the agent choosing to edit
            something, and an agent that answers in prose instead would
            otherwise leave the guide waiting for a change that is not coming. */}
        <button className="nt-tour-next" onClick={onNext}>
          Skip this step
        </button>
        <span className="nt-tour-gap" />
        <button className="nt-tour-skip" onClick={onSkip}>
          Skip the guide
        </button>
      </div>
    </div>
  );
}

/**
 * Under the target, or over it when there is no room under.
 *
 * Falls back to the middle of the window when there is nothing to sit beside —
 * a step whose target has not rendered yet still has something to say, and a
 * card that vanished while the document caught up would read as a glitch.
 */
function position(rect: Rect | null): { style: React.CSSProperties } {
  if (typeof window === "undefined" || !rect) {
    return {
      style: { left: "50%", bottom: 96, transform: "translateX(-50%)", width: WIDTH },
    };
  }
  // A target as tall as the window — the chat rail — has no above and no below.
  // Beside it, level with the middle, is the only placement that reads as
  // pointing AT the thing rather than sitting on top of it.
  if (rect.height > window.innerHeight * 0.6) {
    const beside = rect.x - WIDTH - GAP;
    return {
      style: {
        left: beside > EDGE ? beside : rect.x + rect.width + GAP,
        top: "50%",
        transform: "translateY(-50%)",
        width: WIDTH,
      },
    };
  }
  const below = rect.y + rect.height + GAP;
  const room = window.innerHeight - below;
  // 150 is the card at its tallest — two lines of title, one of action, a foot.
  const above = room < 150 && rect.y > 150;
  const left = Math.min(
    Math.max(EDGE, rect.x),
    Math.max(EDGE, window.innerWidth - WIDTH - EDGE),
  );
  return {
    style: above
      ? { left, top: rect.y - GAP, transform: "translateY(-100%)", width: WIDTH }
      : { left, top: below, width: WIDTH },
  };
}
