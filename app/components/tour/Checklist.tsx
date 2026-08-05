"use client";

import { Check } from "../Icons";

export type ChecklistItem = { id: string; label: string; hint: string };

/**
 * The end of the guide, and the things it did not get to.
 *
 * This is the only place first run says that it is over, so it says it: the
 * beats have all been taught, and what the user is looking at is not a demo
 * they are about to lose. Everything above the rule is that sentence; the
 * items below it are what is left, and they tick themselves off if the user
 * goes and finds them.
 *
 * It ends with a way out that looks like one. The X alone was the only caller
 * of `finish` in the app, so a guide nobody thought to close simply never
 * closed — and an onboarding whose last frame is a panel waiting to be tidied
 * away is not an ending, it is a loose end.
 *
 * Takes the review bar's slot and its geometry, and steps above it when both
 * are up — the same arrangement `.nt-reformat-switcher` already has with it,
 * because the standing question always keeps the corner.
 */
export function Checklist({
  items,
  done,
  drew,
  onDismiss,
}: {
  items: readonly ChecklistItem[];
  done: ReadonlySet<string>;
  /** Whether a diagram actually landed, so the closing line can be true. */
  drew: boolean;
  onDismiss: () => void;
}) {
  const complete = items.every((item) => done.has(item.id));
  return (
    <div className="nt-tour-list">
      <p className="nt-tour-list-title">That is the guide.</p>
      {/* Every clause here has to be true of somebody who stepped past every
          beat, because they reach this card too. So it names what is on the
          page rather than what they did to get it — the diagram only when one
          actually landed, and never the agent's change, which they may well
          have never asked for. */}
      <p className="nt-tour-list-note">
        {drew
          ? "The page, the diagram on it and the chat beside it are yours to keep — none of this was a demo."
          : "The page and the chat beside it are yours to keep — none of this was a demo."}
      </p>

      <div className="nt-tour-list-rest">
        <span className="nt-tour-list-rest-label">
          {complete ? "That is the whole of it." : "Worth knowing"}
        </span>
        <span className="nt-tour-list-count">
          {done.size} of {items.length}
        </span>
      </div>

      <ul className="nt-tour-list-items">
        {items.map((item) => {
          const ticked = done.has(item.id);
          return (
            <li
              key={item.id}
              className={`nt-tour-item${ticked ? " is-done" : ""}`}
            >
              <span className="nt-tour-tick" aria-hidden>
                {ticked ? <Check width={12} height={12} /> : null}
              </span>
              <span className="nt-tour-item-text">
                <span className="nt-tour-item-label">{item.label}</span>
                <span className="nt-tour-item-hint">{item.hint}</span>
              </span>
            </li>
          );
        })}
      </ul>

      <button className="nt-tour-done" onClick={onDismiss}>
        Start working
      </button>
    </div>
  );
}
