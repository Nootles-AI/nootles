"use client";

import { useId } from "react";
import type { PageMode } from "./editor/ai/useTabCompletion";

/** Both tooltips describe what the model does, not what you happen to be doing. */
const MODES: { id: PageMode; label: string; hint: string }[] = [
  { id: "create", label: "Create", hint: "Writes what is not there yet." },
  { id: "complete", label: "Complete", hint: "Only finishes what you started." },
];

/**
 * How far the model is allowed to go on this page. Deliberately a switch rather
 * than something inferred: you already know which one you want, and a control
 * you can flip beats any amount of guessing at it.
 *
 * The hint is the whole point of the control, so it is a real tooltip rather
 * than a `title` attribute, which waits over a second and cannot be styled.
 */
export function ModeToggle({
  mode,
  onChange,
}: {
  mode: PageMode;
  onChange: (mode: PageMode) => void;
}) {
  const id = useId();

  return (
    <div className="ab-mode" role="group" aria-label="Suggestion mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          aria-pressed={mode === m.id}
          aria-describedby={`${id}-${m.id}`}
          data-tip={m.hint}
          className={`ab-mode-btn ab-tip${mode === m.id ? " is-on" : ""}`}
        >
          {m.label}
          {/* The same words for a screen reader, which never sees the tooltip. */}
          <span id={`${id}-${m.id}`} className="sr-only">
            {m.hint}
          </span>
        </button>
      ))}
    </div>
  );
}
