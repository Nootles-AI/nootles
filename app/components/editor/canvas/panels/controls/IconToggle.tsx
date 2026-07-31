"use client";

import type { ReactNode } from "react";
import "./controls.css";

export type ToggleOption<T extends string> = {
  value: T;
  /** Accessible name and tooltip; the icon is all that shows. */
  label: string;
  icon: ReactNode;
};

/**
 * Wears the shell's `.ab-mode` segmented control — same well, same lift on the
 * selected one — sized for a glyph instead of a word. When nothing matches,
 * nothing is pressed, which is the honest reading of a mixed selection.
 */
export function IconToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly ToggleOption<T>[];
}) {
  return (
    <div className="ab-mode">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          aria-label={o.label}
          title={o.label}
          className={`ab-mode-btn is-icon${value === o.value ? " is-on" : ""}`}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
