"use client";

import { useState } from "react";
import { Check } from "@/app/components/Icons";
import {
  DEFAULT_DRAW_CHOICE,
  DRAW_STYLES,
  drawChoiceSchema,
  type DrawChoice,
} from "@/app/lib/ai/drawStyles";
import { STYLE_SWATCHES } from "./drawStyleSwatches";

/**
 * The question a drawing asks before it is drawn: which style, how eccentric.
 *
 * One card answers the whole salvo — a storyboard is one film, not nine
 * choices — and the turn is held open behind it exactly the way a deletion
 * is: nothing runs until Draw or Skip. The last confirmed choice is where the
 * card opens next time, so a retry after a missed shot is a single click.
 */

const REMEMBER = "nt-draw-style";

/** The dial's ends, named. The numbers in between are the model's own scale. */
const LEVELS = ["literal", "plain", "composed", "expressive", "dramatic", "eccentric"];

function lastChoice(): DrawChoice {
  if (typeof window === "undefined") return DEFAULT_DRAW_CHOICE;
  try {
    const parsed = drawChoiceSchema.safeParse(
      JSON.parse(window.localStorage.getItem(REMEMBER) ?? ""),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Never let a stale or hand-edited value keep the picker from opening.
  }
  return DEFAULT_DRAW_CHOICE;
}

export function DrawStylePicker({
  count,
  onAnswer,
}: {
  /** How many drawings are waiting on this one answer. */
  count: number;
  /** The settled choice — or null to leave them undrawn. */
  onAnswer: (choice: DrawChoice | null) => void;
}) {
  const [choice, setChoice] = useState<DrawChoice>(lastChoice);

  const confirm = () => {
    try {
      window.localStorage.setItem(REMEMBER, JSON.stringify(choice));
    } catch {
      // Remembering is a nicety; drawing is the point.
    }
    onAnswer(choice);
  };

  return (
    <div role="alert" className="nt-turn-confirm">
      <p className="text-sm font-medium">
        {count === 1 ? "Style for this drawing" : `Style for these ${count} drawings`}
      </p>

      <div className="nt-draw-grid" role="radiogroup" aria-label="Drawing style">
        {DRAW_STYLES.map((style) => {
          const selected = style === choice.style;
          return (
            <button
              key={style}
              role="radio"
              aria-checked={selected}
              title={style}
              className={`nt-draw-cell${selected ? " is-selected" : ""}`}
              onClick={() => setChoice((c) => ({ ...c, style }))}
            >
              <span className="nt-draw-swatch">
                <svg viewBox="0 0 32 24" preserveAspectRatio="xMidYMid slice" aria-hidden>
                  {STYLE_SWATCHES[style]}
                </svg>
                {selected && (
                  <span className="nt-draw-tick" aria-hidden>
                    <Check width={9} height={9} />
                  </span>
                )}
              </span>
              <span className="nt-draw-name">{style}</span>
            </button>
          );
        })}
      </div>

      <div className="nt-draw-level">
        <div className="nt-draw-level-head">
          <span id="nt-draw-level-label">Artistic level</span>
          <span className="nt-draw-level-value">{LEVELS[choice.artisticLevel]}</span>
        </div>
        {/* The track and its notches are drawn here; the input keeps the
            gesture, the arrow keys and the name, and shows only its thumb. */}
        <div
          className="nt-draw-slider"
          style={{ "--p": choice.artisticLevel / 5 } as React.CSSProperties}
        >
          <span className="nt-draw-track" aria-hidden>
            <span className="nt-draw-fill" />
          </span>
          <span className="nt-draw-notches" aria-hidden>
            {LEVELS.map((_, i) => (
              <span
                key={i}
                className={`nt-draw-notch${i <= choice.artisticLevel ? " is-past" : ""}`}
              />
            ))}
          </span>
          <input
            type="range"
            min={0}
            max={5}
            step={1}
            value={choice.artisticLevel}
            aria-labelledby="nt-draw-level-label"
            aria-valuetext={`${choice.artisticLevel}, ${LEVELS[choice.artisticLevel]}`}
            onChange={(e) =>
              setChoice((c) => ({ ...c, artisticLevel: Number(e.target.value) }))
            }
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-1.5">
        <button className="nt-rewind-action" onClick={() => onAnswer(null)}>
          Skip
        </button>
        <button className="nt-rewind-action is-primary" onClick={confirm}>
          {count === 1 ? "Draw" : `Draw ${count}`}
        </button>
      </div>
    </div>
  );
}
