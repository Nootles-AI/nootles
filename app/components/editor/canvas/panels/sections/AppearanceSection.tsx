"use client";

import { useRef, useState } from "react";
import { ChevronRight } from "@/app/components/Icons";
import type { StyleMap } from "../../scene/types";
import { Field } from "../controls/Field";
import { useLiveEdit } from "../controls/live";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import { track } from "../controls/track";
import { BLEND_MODES, parseLayers, serializeLayers } from "../cssCatalog";
import type { SectionProps } from "../StylePanel";

const BLEND = BLEND_MODES.map((id) => ({
  value: id,
  label: id[0].toUpperCase() + id.slice(1).replace(/-/g, " "),
}));

/** The `filter()` functions people reach for by name, as percentages. */
const ADJUSTMENTS = [
  { fn: "brightness", label: "Brightness", base: 100 },
  { fn: "contrast", label: "Contrast", base: 100 },
  { fn: "saturate", label: "Saturation", base: 100 },
  { fn: "grayscale", label: "Grayscale", base: 0 },
] as const;

/** `brightness(1.2)` and `brightness(120%)` are the same filter. */
function percent(value: string | undefined, base: number): number {
  const n = Number.parseFloat(value ?? "");
  if (!Number.isFinite(n)) return base;
  return Math.round((value ?? "").includes("%") ? n : n * 100);
}

function readAdjust(style: StyleMap, fn: string, base: number): number {
  const layer = parseLayers("filter", style.filter).find(
    (l) => l.values["filter-fn"] === fn,
  );
  return percent(layer?.values["filter-value"], base);
}

/**
 * Emits the whole way through the drag, so the canvas dims with the knob; the
 * history bracket around the gesture is what turns that back into one entry.
 * One write per frame, however fast the pointer moves.
 */
function Slider({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  // The drag's handlers are built at pointer-down and cannot read the draft off
  // that render. The ref is what they emit. `sent` keeps a frame that changed
  // nothing free.
  const drag = useRef<{ next: number; sent: number; frame: number } | null>(null);
  const live = useLiveEdit();
  const shown = draft ?? value;

  const push = () => {
    const d = drag.current;
    if (!d || d.sent === d.next) return;
    d.sent = d.next;
    onChange(d.next);
  };

  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { next: value, sent: value, frame: 0 };
    live?.begin();
    track(
      e,
      (x) => {
        const d = drag.current;
        if (!d) return;
        d.next = Math.round(x * 100) / 100;
        if (d.frame !== 0) return;
        d.frame = requestAnimationFrame(() => {
          d.frame = 0;
          setDraft(d.next);
          push();
        });
      },
      () => {
        const d = drag.current;
        if (d?.frame) cancelAnimationFrame(d.frame);
        push();
        drag.current = null;
        setDraft(null);
        live?.end();
      },
    );
  };

  return (
    <div
      className="ab-ctl-slider"
      style={{
        background: `linear-gradient(90deg, var(--border-strong) ${shown * 100}%, var(--sunken) ${shown * 100}%)`,
      }}
      onPointerDown={start}
    >
      <span className="ab-ctl-knob" style={{ left: `${shown * 100}%` }} />
    </div>
  );
}

export function AppearanceSection({ selection, patch, setStyle }: SectionProps) {
  const [open, setOpen] = useState<boolean | null>(null);

  const opacities = selection.map((n) => {
    const v = Number.parseFloat(n.style.opacity ?? "1");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  });
  const opacity = opacities[0];
  const opacityMixed = opacities.some((v) => v !== opacity);

  const blends = selection.map((n) => n.style["mix-blend-mode"] ?? "normal");
  const blendMixed = blends.some((v) => v !== blends[0]);

  const adjustments = ADJUSTMENTS.map((a) => {
    const values = selection.map((n) => readAdjust(n.style, a.fn, a.base));
    return { ...a, value: values[0], mixed: values.some((v) => v !== values[0]) };
  });
  const adjusted = adjustments.some((a) => a.mixed || a.value !== a.base);
  const showAdjust = open ?? adjusted;

  const setOpacity = (value: number) =>
    setStyle({ opacity: value === 1 ? undefined : String(value) });

  const setAdjust = (fn: string, value: number, base: number) =>
    patch((node) => {
      const layers = parseLayers("filter", node.style.filter);
      const i = layers.findIndex((l) => l.values["filter-fn"] === fn);
      const next =
        value === base
          ? layers.filter((_, j) => j !== i)
          : i >= 0
            ? layers.map((l, j) =>
                j === i
                  ? { ...l, values: { ...l.values, "filter-value": `${value}%` } }
                  : l,
              )
            : [...layers, { values: { "filter-fn": fn, "filter-value": `${value}%` } }];
      const style = { ...node.style };
      const filter = serializeLayers("filter", next);
      if (filter) style.filter = filter;
      else delete style.filter;
      return { style };
    });

  return (
    <PanelSection title="Appearance">
      <Field label="Opacity">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Slider value={opacity} onChange={setOpacity} />
          </div>
          <div className="w-16 shrink-0">
            <NumberField
              value={Math.round(opacity * 100)}
              mixed={opacityMixed}
              unit="%"
              min={0}
              max={100}
              onChange={(n) => setOpacity(n / 100)}
            />
          </div>
        </div>
      </Field>

      <Field label="Blend">
        <SelectField
          value={blendMixed ? "" : blends[0]}
          options={blendMixed ? [{ value: "", label: "Mixed" }, ...BLEND] : BLEND}
          onChange={(value) => {
            if (value)
              setStyle({ "mix-blend-mode": value === "normal" ? undefined : value });
          }}
        />
      </Field>

      <button
        onClick={() => setOpen(!showAdjust)}
        aria-expanded={showAdjust}
        className="ab-ctl-section-toggle"
      >
        <ChevronRight
          width={12}
          height={12}
          className={`ab-ctl-chevron${showAdjust ? " is-open" : ""}`}
        />
        <span>Adjust</span>
      </button>

      {showAdjust &&
        adjustments.map((a) => (
          <Field key={a.fn} label={a.label}>
            <NumberField
              value={a.value}
              mixed={a.mixed}
              unit="%"
              min={0}
              max={a.fn === "grayscale" ? 100 : 400}
              onChange={(n) => setAdjust(a.fn, n, a.base)}
            />
          </Field>
        ))}
    </PanelSection>
  );
}
