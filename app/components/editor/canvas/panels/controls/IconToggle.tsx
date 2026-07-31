"use client";

import type { ReactNode } from "react";
import { Tooltip } from "@/app/components/Tooltip";
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
 *
 * Every button carries a real tooltip. The text section used to keep a private
 * copy of this control for exactly that reason; a glyph nobody can name is the
 * thing this panel had most of.
 *
 * The buttons share the row equally rather than sizing to their glyphs: two
 * fixed-width toggles in one row overflowed the text section by 12px.
 */
export function IconToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T | "";
  onChange: (value: T) => void;
  options: readonly ToggleOption<T>[];
}) {
  return (
    <div className="ab-mode is-fill">
      {/* The anchor is a flex box, not `display: contents` — the tooltip
          measures its anchor, and a box-less one reports a zero rect. */}
      {options.map((o) => (
        <Tooltip key={o.value} label={o.label} className="ab-ctl-anchor">
          <button
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            aria-label={o.label}
            className={`ab-mode-btn is-icon${value === o.value ? " is-on" : ""}`}
          >
            {o.icon}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
