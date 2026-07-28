"use client";

import type { PageMode } from "./editor/ai/useTabCompletion";

const MODES: { id: PageMode; label: string; hint: string }[] = [
  {
    id: "compose",
    label: "Compose",
    hint: "Writing from your own head — suggestions lean in.",
  },
  {
    id: "transcribe",
    label: "Transcribe",
    hint: "Notes on a meeting or video — only suggests what the page already implies.",
  },
];

/**
 * Which way the page leans. Deliberately visible rather than inferred: in a
 * meeting you already know you are transcribing, and a switch you can flip
 * beats any amount of guessing at it.
 */
export function ModeToggle({
  mode,
  onChange,
}: {
  mode: PageMode;
  onChange: (mode: PageMode) => void;
}) {
  return (
    <div className="ab-mode" role="group" aria-label="Suggestion mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          onClick={() => onChange(m.id)}
          title={m.hint}
          aria-pressed={mode === m.id}
          className={`ab-mode-btn${mode === m.id ? " is-on" : ""}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
