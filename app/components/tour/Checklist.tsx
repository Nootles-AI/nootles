"use client";

import { Check, X } from "../Icons";

export type ChecklistItem = { id: string; label: string; hint: string };

/**
 * The free tail.
 *
 * Nothing here is gated, spotlit or in the way: the three hero beats have been
 * taught and the user is now working in their own document. This only says what
 * else is here, ticks itself off when they find it, and can be closed at any
 * point without being asked twice.
 *
 * Takes the review bar's slot and its geometry, and steps above it when both
 * are up — the same arrangement `.nt-reformat-switcher` already has with it,
 * because the standing question always keeps the corner.
 */
export function Checklist({
  items,
  done,
  onDismiss,
}: {
  items: readonly ChecklistItem[];
  done: ReadonlySet<string>;
  onDismiss: () => void;
}) {
  const complete = items.every((item) => done.has(item.id));
  return (
    <div className="nt-tour-list">
      <div className="nt-tour-list-head">
        <span className="nt-tour-list-title">
          {complete ? "That is the whole of it." : "While you are here"}
        </span>
        <span className="nt-tour-list-count">
          {done.size} of {items.length}
        </span>
        <button
          className="nt-icon-btn is-sm"
          onClick={onDismiss}
          aria-label="Dismiss the guide"
          title="Dismiss the guide"
        >
          <X width={11} height={11} />
        </button>
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
    </div>
  );
}
