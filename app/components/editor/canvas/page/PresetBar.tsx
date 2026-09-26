"use client";

import type { ComponentType, KeyboardEvent, SVGProps } from "react";
import { Browser, Flowchart, Kanban, Matrix, Phone, Timeline, X } from "@/app/components/Icons";
import { PRESETS, type Preset, type PresetId } from "../presets";

const GLYPH: Record<PresetId, ComponentType<SVGProps<SVGSVGElement>>> = {
  flowchart: Flowchart,
  phone: Phone,
  browser: Browser,
  matrix: Matrix,
  timeline: Timeline,
  board: Kanban,
};

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * A new diagram's starting points, in the empty band where "Add shapes" would
 * be. It speaks for itself on the keyboard — the page's keymap stands aside
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
      <button
        type="button"
        className="nt-canvas-presets-no"
        aria-label="Close presets"
        title="Close"
        onClick={onClose}
      >
        <X width={12} height={12} />
      </button>
    </div>
  );
}
