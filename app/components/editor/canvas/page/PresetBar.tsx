"use client";

import type { ComponentType, KeyboardEvent, SVGProps } from "react";
import { Blank, Browser, Flowchart, Matrix, Phone, Timeline } from "@/app/components/Icons";
import { PRESETS, type Preset, type PresetId } from "../presets";
import { presetStep } from "./presetWalk";

const GLYPH: Record<PresetId, ComponentType<SVGProps<SVGSVGElement>>> = {
  flowchart: Flowchart,
  phone: Phone,
  browser: Browser,
  matrix: Matrix,
  timeline: Timeline,
};

/**
 * A new diagram's starting points, in the empty band where "Add shapes" would
 * be: Blank, or one of the presets. Blank is the offer declined — the band is
 * left empty with its "Add shapes" line, as Escape leaves it. It speaks for
 * itself on the keyboard — the page's keymap stands aside for it
 * (`pageKeymap.ts`): the arrows walk it (`presetStep`), ← off its first option
 * and → off its last `onLeave` it, and Escape `onEscape`s it.
 */
export function PresetBar({
  onPick,
  onClose,
  onEscape,
  onLeave,
}: {
  onPick: (preset: Preset) => void;
  onClose: () => void;
  onEscape: () => void;
  onLeave: (dir: -1 | 1) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const step = presetStep(event.key, buttons.indexOf(document.activeElement as HTMLButtonElement), buttons.length);
    if (!step) return;
    event.preventDefault();
    if ("leave" in step) onLeave(step.leave);
    else buttons[step.focus].focus();
  };

  return (
    <div
      className="nt-canvas-presets"
      role="toolbar"
      aria-label="Start from a preset"
      // A press here is the bar's, never the start of a marquee or a draw.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <button type="button" className="nt-canvas-preset" data-preset="blank" title="Start from nothing" onClick={onClose}>
        <Blank width={14} height={14} strokeWidth={1.8} aria-hidden />
        Blank
      </button>
      <span className="nt-canvas-presets-or" aria-hidden>
        or
      </span>
      {PRESETS.map((preset) => {
        const Glyph = GLYPH[preset.id];
        return (
          <button
            key={preset.id}
            type="button"
            className="nt-canvas-preset"
            data-preset={preset.id}
            title={preset.title}
            onClick={() => onPick(preset)}
          >
            <Glyph width={14} height={14} strokeWidth={1.8} aria-hidden />
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
