"use client";

import type { ComponentType, KeyboardEvent, SVGProps } from "react";
import { Blank, Browser, Flowchart, Matrix, Phone, Timeline } from "@/app/components/Icons";
import { PRESETS, type Preset, type PresetId } from "../presets";

const GLYPH: Record<PresetId, ComponentType<SVGProps<SVGSVGElement>>> = {
  flowchart: Flowchart,
  phone: Phone,
  browser: Browser,
  matrix: Matrix,
  timeline: Timeline,
};

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * A new diagram's starting points, in the empty band where "Add shapes" would
 * be: Blank, or one of the presets. Blank is the offer declined — the band is
 * left empty with its "Add shapes" line, as Escape leaves it. It speaks for itself on the keyboard — the page's keymap stands aside
 * for it (`pageKeymap.ts`) — so the arrows walk it and Escape closes it.
 */
export function PresetBar({ onPick, onClose }: { onPick: (preset: Preset) => void; onClose: () => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      event.key in STEP
        ? (at + STEP[event.key] + buttons.length) % buttons.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : -1;
    if (to < 0) return;
    event.preventDefault();
    buttons[to].focus();
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
