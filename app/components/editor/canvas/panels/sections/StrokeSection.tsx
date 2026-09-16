"use client";

import { X } from "@/app/components/Icons";
import { ColorField } from "../controls/ColorField";
import { Dash as DashGlyph, StrokeWeight } from "../controls/glyphs";
import { IconButton } from "../controls/IconButton";
import { IconToggle } from "../controls/IconToggle";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import {
  drawn,
  readStroke,
  writeStroke,
  DEFAULT_STROKE,
  type Position,
  type Stroke,
} from "../strokes";
import type { SectionProps } from "../StylePanel";

const DASHES = (["solid", "dashed", "dotted"] as const).map((kind) => ({
  value: kind,
  label: kind[0].toUpperCase() + kind.slice(1),
  icon: <DashGlyph kind={kind} />,
}));

// Named rather than drawn: three near-identical box glyphs are a guessing game,
// and Figma spells this one out too.
const POSITIONS = [
  { value: "inside", label: "Inside" },
  { value: "center", label: "Centre" },
  { value: "outside", label: "Outside" },
];

export function StrokeSection({ selection, patch }: SectionProps) {
  const strokes = selection.map(readStroke);
  const base = strokes.find((stroke): stroke is Stroke => stroke !== null) ?? null;

  // Each node keeps its own other fields, so editing one control across a
  // mixed selection changes only that control.
  const apply = (delta: Partial<Stroke>) =>
    patch((node) => ({
      style: writeStroke(node, {
        ...(readStroke(node) ?? base ?? DEFAULT_STROKE),
        ...delta,
      }),
    }));

  if (!base)
    return (
      <PanelSection title="Stroke" onAdd={() => apply({})}>
        <span className="nt-ctl-empty">No stroke</span>
      </PanelSection>
    );

  const differs = (get: (stroke: Stroke) => string | number) =>
    strokes.some((stroke) => !stroke || get(stroke) !== get(base));

  return (
    <PanelSection title="Stroke">
      <div className="nt-ctl-row">
        <ColorField
          value={base.color}
          mixed={differs((s) => s.color)}
          onChange={(color) => apply({ color })}
        />
        <IconButton
          label="Remove stroke"
          onClick={() => patch((node) => ({ style: writeStroke(node, null) }))}
        >
          <X width={13} height={13} />
        </IconButton>
      </div>

      <div className="nt-ctl-grid">
        <NumberField
          label={<StrokeWeight />}
          name="Stroke weight"
          value={base.width}
          mixed={differs((s) => s.width)}
          unit="px"
          min={0}
          step={0.5}
          onChange={(width) => apply({ width })}
        />
        <span className="nt-ctl-wide-end">
          <IconToggle
            value={differs((s) => s.dash) ? "" : base.dash}
            options={DASHES}
            onChange={(dash) => apply({ dash })}
          />
        </span>
      </div>

      {!selection.every(drawn) && (
        <div className="nt-ctl-row">
          <SelectField
            label="Align"
            name="Stroke alignment"
            value={differs((s) => s.position) ? "" : base.position}
            options={
              differs((s) => s.position)
                ? [{ value: "", label: "Mixed" }, ...POSITIONS]
                : POSITIONS
            }
            onChange={(position) => {
              if (position) apply({ position: position as Position });
            }}
          />
        </div>
      )}
    </PanelSection>
  );
}
