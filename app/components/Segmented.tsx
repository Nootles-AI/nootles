"use client";

import { useId, type CSSProperties, type ReactNode } from "react";

export type Segment<T extends string> = {
  id: T;
  label: string;
  hint: string;
  /** A glyph before the word, where the word alone undersells a choice. */
  icon?: ReactNode;
};

/**
 * A choice between two or three named behaviours, in the metadata voice.
 *
 * Deliberately a switch rather than something inferred: you already know which
 * one you want, and a control you can flip beats any amount of guessing at it.
 *
 * The hint is the whole point of the control, so it is a real tooltip rather
 * than a `title` attribute, which waits over a second and cannot be styled.
 */
export function Segmented<T extends string>({
  label,
  segments,
  value,
  onChange,
  tipUp,
  chosenSaidBelow,
}: {
  label: string;
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Set where an opening tooltip would otherwise be clipped by the viewport. */
  tipUp?: boolean;
  /** Set where a note under the control already says the chosen segment's
      hint, which its tooltip would only cover. */
  chosenSaidBelow?: boolean;
}) {
  const id = useId();

  return (
    <div
      className="nt-mode is-even"
      role="group"
      aria-label={label}
      style={
        {
          "--n": segments.length,
          "--at": Math.max(0, segments.findIndex((s) => s.id === value)),
        } as CSSProperties
      }
    >
      {segments.map((s) => (
        <button
          key={s.id}
          // Never a submit: it is as often inside a form as not.
          type="button"
          onClick={() => onChange(s.id)}
          aria-pressed={value === s.id}
          aria-describedby={`${id}-${s.id}`}
          data-tip={s.hint}
          className={`nt-mode-btn${
            chosenSaidBelow && value === s.id ? "" : ` nt-tip${tipUp ? " is-up" : ""}`
          }${value === s.id ? " is-on" : ""}${s.icon ? " has-icon" : ""}`}
        >
          {s.icon}
          {s.label}
          {/* The same words for a screen reader, which never sees the tooltip. */}
          <span id={`${id}-${s.id}`} className="sr-only">
            {s.hint}
          </span>
        </button>
      ))}
    </div>
  );
}
