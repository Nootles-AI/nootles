"use client";

import { useId } from "react";
import type { PageMode } from "./editor/ai/useTabCompletion";

const MODES: { id: PageMode; label: string; hint: string }[] = [
  {
    id: "compose",
    label: "Compose",
    hint: "Writing from your own head. Suggestions lean in, and can propose code, math and diagrams.",
  },
  {
    id: "transcribe",
    label: "Transcribe",
    hint: "Notes on a meeting or video. Only suggests what the page already implies — finishing a word, or continuing a list.",
  },
];

/**
 * Which way the page leans. Deliberately visible rather than inferred: in a
 * meeting you already know you are transcribing, and a switch you can flip
 * beats any amount of guessing at it.
 *
 * The hint is the whole point of the control — "transcribe" means nothing on
 * its own — so it is a real tooltip rather than a `title` attribute, which
 * waits over a second and cannot be styled.
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
