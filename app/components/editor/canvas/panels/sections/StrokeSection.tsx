"use client";

import { X } from "@/app/components/Icons";
import type { SceneNode, StyleMap } from "../../scene/types";
import { ColorField } from "../controls/ColorField";
import { Field } from "../controls/Field";
import { IconToggle } from "../controls/IconToggle";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import { parseComposite, serializeComposite } from "../cssCatalog";
import type { SectionProps } from "../StylePanel";

type Dash = "solid" | "dashed" | "dotted";
type Position = "inside" | "center" | "outside";
type Stroke = { color: string; width: number; dash: Dash; position: Position };

const DEFAULT_STROKE: Stroke = {
  color: "#111111",
  width: 1,
  dash: "solid",
  position: "inside",
};

const DASHARRAY: Record<Dash, string> = {
  solid: "none",
  dashed: "8 6",
  dotted: "2 4",
};

const EDGES = ["width", "style", "color"] as const;

// Every spelling of a box stroke, so writing one never leaves half of another
// behind for the cascade to resolve in the panel's favour or against it.
const BOX_PROPS = [
  "border",
  "outline",
  "outline-offset",
  ...EDGES.flatMap((part) => [`border-${part}`, `outline-${part}`]),
];
const PATH_PROPS = [
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
];

function Line({ dash }: { dash?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 8h11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={dash}
      />
    </svg>
  );
}

const DASHES = [
  { value: "solid", label: "Solid", dash: undefined },
  { value: "dashed", label: "Dashed", dash: "4 3" },
  { value: "dotted", label: "Dotted", dash: "0.1 3" },
].map(({ value, label, dash }) => ({ value, label, icon: <Line dash={dash} /> }));

// Named rather than drawn: three near-identical box glyphs are a guessing game,
// and Figma spells this one out too.
const POSITIONS = [
  { value: "inside", label: "Inside" },
  { value: "center", label: "Centre" },
  { value: "outside", label: "Outside" },
];

const dashOf = (value: string | undefined): Dash =>
  value === DASHARRAY.dashed ? "dashed" : value === DASHARRAY.dotted ? "dotted" : "solid";

const styleOf = (value: string | undefined): Dash =>
  value === "dashed" ? "dashed" : value === "dotted" ? "dotted" : "solid";

/** The shorthand as authored, or the same stroke spelled as longhands — which
 *  is what a model reaching for `border-width` writes. */
function shorthandOf(style: StyleMap, prop: "border" | "outline"): string | undefined {
  const parts = EDGES.map((part) => style[`${prop}-${part}`]).filter(Boolean);
  return style[prop] ?? (parts.length ? parts.join(" ") : undefined);
}

function readStroke(node: SceneNode): Stroke | null {
  if (node.kind === "path") {
    const color = node.style.stroke;
    if (!color || color === "none") return null;
    const width = Number.parseFloat(node.style["stroke-width"] ?? "");
    return {
      color,
      width: Number.isFinite(width) ? width : 1,
      dash: dashOf(node.style["stroke-dasharray"]),
      position: "center",
    };
  }
  const outline = shorthandOf(node.style, "outline");
  const source = outline ?? shorthandOf(node.style, "border");
  if (!source) return null;
  // `border` and `outline` are the same shorthand grammar, so the catalogue's
  // border parser reads either one.
  const parts = parseComposite("border", source).values;
  const width = Number.parseFloat(parts["border-width"] ?? "");
  // A zero-weight stroke is still a stroke: it keeps its colour, and the field
  // it was scrubbed down to zero in is the one that scrubs it back up. Only the
  // remove button takes it away.
  if (!Number.isFinite(width)) return null;
  return {
    color: parts["border-color"] ?? "#000000",
    width,
    dash: styleOf(parts["border-style"]),
    position: outline
      ? Number.parseFloat(node.style["outline-offset"] ?? "0") < 0
        ? "center"
        : "outside"
      : "inside",
  };
}

function writeStroke(node: SceneNode, stroke: Stroke | null): StyleMap {
  const style = { ...node.style };
  const path = node.kind === "path";
  for (const prop of path ? PATH_PROPS : BOX_PROPS) delete style[prop];
  if (!stroke) return style;

  if (path) {
    // An SVG stroke is always centred on the path, so alignment says nothing here.
    style.stroke = stroke.color;
    style["stroke-width"] = String(stroke.width);
    if (stroke.dash !== "solid") style["stroke-dasharray"] = DASHARRAY[stroke.dash];
    return style;
  }

  const value = serializeComposite("border", {
    values: {
      "border-width": `${stroke.width}px`,
      "border-style": stroke.dash,
      "border-color": stroke.color,
    },
  });

  // CSS has no stroke position, so the three are mapped onto the two things CSS
  // does have. A `border` is drawn inside the box — every node is border-boxed
  // by the renderer, so it never disturbs the geometry the attributes state —
  // and an `outline` is drawn outside it, taking no space at all. Centre is that
  // outline pulled back by half its weight, which leaves it straddling the edge.
  // This is the one place the panel bends CSS to Figma.
  if (stroke.position === "inside") {
    style.border = value;
  } else {
    style.outline = value;
    if (stroke.position === "center") style["outline-offset"] = `${-stroke.width / 2}px`;
  }
  return style;
}

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
        {null}
      </PanelSection>
    );

  const differs = (get: (stroke: Stroke) => string | number) =>
    strokes.some((stroke) => !stroke || get(stroke) !== get(base));

  return (
    <PanelSection title="Stroke">
      <div className="ab-ctl-row">
        <ColorField
          value={base.color}
          mixed={differs((s) => s.color)}
          onChange={(color) => apply({ color })}
        />
        <button
          className="ab-icon-btn ab-ctl-remove"
          aria-label="Remove stroke"
          title="Remove stroke"
          onClick={() => patch((node) => ({ style: writeStroke(node, null) }))}
        >
          <X width={13} height={13} />
        </button>
      </div>

      <Field label="Weight">
        <NumberField
          value={base.width}
          mixed={differs((s) => s.width)}
          unit="px"
          min={0}
          step={0.5}
          onChange={(width) => apply({ width })}
        />
        <IconToggle
          value={differs((s) => s.dash) ? "" : base.dash}
          options={DASHES}
          onChange={(dash) => apply({ dash: dash as Dash })}
        />
      </Field>

      {!selection.every((node) => node.kind === "path") && (
        <Field label="Position">
          <SelectField
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
        </Field>
      )}
    </PanelSection>
  );
}
