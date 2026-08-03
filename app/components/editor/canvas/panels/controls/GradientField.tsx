"use client";

import { useRef, useState } from "react";
import { X } from "@/app/components/Icons";
import {
  resolveVars,
  useColorVariables,
  type ColorVariable,
} from "../colorVariables";
import { ColorField, Swatch } from "./ColorField";
import { useLiveEdit } from "./live";
import { NumberField } from "./NumberField";
import { Popover } from "./Popover";
import { SelectField } from "./SelectField";
import { track } from "./track";
import {
  DEFAULT_GRADIENT,
  formatGradient,
  parseGradient,
  type Gradient,
} from "./gradient";
import "./controls.css";

const KINDS = [
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
];

/** Stops land on whole percents — the value the grammar stores anyway. */
const quantise = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;

const NO_VARS: readonly ColorVariable[] = [];

/** The preview bar reads left to right whatever the angle says. */
const stopList = (g: Gradient, vars: readonly ColorVariable[]) =>
  [...g.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${resolveVars(s.color, vars)} ${Math.round(s.pos * 100)}%`)
    .join(", ");

export function GradientField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const vars = useColorVariables()?.variables ?? NO_VARS;
  const gradient = parseGradient(value) ?? DEFAULT_GRADIENT;

  return (
    <Popover
      width={240}
      label="Gradient"
      trigger={(p) => (
        <button {...p} className="nt-ctl-swatch">
          <Swatch color={resolveVars(value, vars)} />
          <span className="nt-ctl-swatch-text">
            {gradient.kind === "linear" ? "Linear" : "Radial"}
          </span>
        </button>
      )}
    >
      {() => <Editor gradient={gradient} vars={vars} onChange={onChange} />}
    </Popover>
  );
}

function Editor({
  gradient,
  vars,
  onChange,
}: {
  gradient: Gradient;
  vars: readonly ColorVariable[];
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState<Gradient | null>(null);
  const [picked, setPicked] = useState(0);
  // The drag's end handler is built at pointer-down and cannot read the draft
  // off that render. The ref is what it commits.
  const held = useRef<Gradient | null>(null);
  // Writing a stop is a shape op, cheap enough to do every frame; the panel's
  // own bracket keeps a whole drag one undo entry.
  const live = useLiveEdit() !== null;

  const g = draft ?? gradient;
  const sel = Math.min(picked, g.stops.length - 1);
  const stop = g.stops[sel];

  const emit = (next: Gradient) => onChange(formatGradient(next));
  /** A live drag already sent its last frame. */
  const commit = () => {
    const next = held.current;
    held.current = null;
    setDraft(null);
    if (next && !live) emit(next);
  };
  const moveStop = (i: number, pos: number): Gradient => ({
    ...g,
    stops: g.stops.map((s, j) => (j === i ? { ...s, pos } : s)),
  });

  // One handler for the whole bar: a hit on a handle drags it, a hit on the
  // track adds one there.
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const hit = (e.target as HTMLElement).dataset.stop;
    const r = e.currentTarget.getBoundingClientRect();
    if (hit === undefined) {
      const pos = quantise((e.clientX - r.left) / r.width);
      const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
      const next = sorted.find((s) => s.pos >= pos) ?? sorted[sorted.length - 1];
      setPicked(g.stops.length);
      emit({ ...g, stops: [...g.stops, { color: next.color, pos }] });
      return;
    }
    const i = Number(hit);
    setPicked(i);
    // Many pointer positions round to one stop, and those frames cost nothing.
    let last = g.stops[i].pos;
    track(
      e,
      (x) => {
        const pos = quantise(x);
        if (pos === last) return;
        last = pos;
        const next = moveStop(i, pos);
        held.current = next;
        setDraft(next);
        if (live) emit(next);
      },
      commit,
      { batch: true },
    );
  };

  return (
    <>
      <div
        className="nt-ctl-bar"
        style={{ backgroundImage: `linear-gradient(90deg, ${stopList(g, vars)})` }}
        onPointerDown={onBarDown}
      >
        {g.stops.map((s, i) => (
          <button
            key={i}
            data-stop={i}
            aria-label={`Stop ${i + 1}`}
            aria-pressed={i === sel}
            className={`nt-ctl-stop${i === sel ? " is-on" : ""}`}
            style={{ left: `${s.pos * 100}%`, background: resolveVars(s.color, vars) }}
          />
        ))}
      </div>

      <div className="nt-ctl-row">
        <SelectField
          value={g.kind}
          options={KINDS}
          onChange={(kind) => emit({ ...g, kind: kind as Gradient["kind"] })}
        />
        {g.kind === "linear" && (
          <span className="nt-ctl-narrow">
            <NumberField
              value={g.angle}
              unit="°"
              onChange={(angle) => emit({ ...g, angle })}
            />
          </span>
        )}
      </div>

      <div className="nt-ctl-row">
        <ColorField
          value={stop.color}
          onChange={(color) =>
            emit({
              ...g,
              stops: g.stops.map((s, j) => (j === sel ? { ...s, color } : s)),
            })
          }
        />
        <span className="nt-ctl-narrow">
          <NumberField
            value={Math.round(stop.pos * 100)}
            unit="%"
            min={0}
            max={100}
            onChange={(pct) => emit(moveStop(sel, pct / 100))}
          />
        </span>
        <button
          className="nt-icon-btn is-sm"
          aria-label="Remove stop"
          title="Remove stop"
          disabled={g.stops.length <= 2}
          onClick={() => emit({ ...g, stops: g.stops.filter((_, j) => j !== sel) })}
        >
          <X width={13} height={13} />
        </button>
      </div>
    </>
  );
}
