"use client";

import { X } from "@/app/components/Icons";
import type { SceneNode } from "../../scene/types";
import { ColorField } from "../controls/ColorField";
import { GradientField } from "../controls/GradientField";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import { formatColor, parseColor } from "../controls/color";
import { formatGradient, parseGradient, type Gradient } from "../controls/gradient";
import { parseLayers, serializeLayers, type Layer } from "../cssCatalog";
import { refName } from "../colorVariables";
import type { SectionProps } from "../StylePanel";

type Patch = SectionProps["patch"];

type FillType = "solid" | "linear" | "radial" | "image";

/**
 * One entry of the `background` stack as the panel edits it. `paint` is a
 * colour, a gradient or a `url()` according to `type`; `layer` carries the rest
 * of that layer's declarations — position, size, repeat, anything unrecognised
 * — so editing the paint never drops them.
 */
type Fill = { type: FillType; paint: string; layer: Layer };

const IMAGE = "background-image";
const COLOR = "background-color";
const POSITION = "background-position";
const SIZE = "background-size";
const REPEAT = "background-repeat";
const DEFAULT_PAINT = "#d4d4d8";

const TYPES = [
  { value: "solid", label: "Solid" },
  { value: "linear", label: "Linear" },
  { value: "radial", label: "Radial" },
  { value: "image", label: "Image" },
];

const SIZES = [
  { value: "cover", label: "Fill" },
  { value: "contain", label: "Fit" },
  { value: "auto", label: "Auto" },
];

const isFlat = (g: Gradient) =>
  g.stops.length === 2 && g.stops[0].color === g.stops[1].color;

/** A paint with no alpha to set — `var(--brand)`, `currentColor` — is returned
 *  as it stands rather than resolved to a colour, because resolving it is what
 *  would silently break the binding. */
const withAlpha = (css: string, a: number) => {
  const rgb = parseColor(css);
  return rgb ? formatColor({ ...rgb, a }) : css;
};

/** Bound to a colour variable, so its alpha is the variable's to give. */
const isBound = (fill: Fill): boolean =>
  fill.type === "solid"
    ? refName(fill.paint) !== null
    : fill.type !== "image" &&
      (parseGradient(fill.paint)?.stops.some((s) => refName(s.color) !== null) ??
        false);

const srcOf = (paint: string) => paint.replace(/^url\(\s*["']?|["']?\s*\)$/g, "");
const toUrl = (src: string) => `url("${src.replace(/"/g, "%22")}")`;

function readFill(layer: Layer): Fill {
  const image = layer.values[IMAGE];
  if (image && image !== "none") {
    if (/^(url|image-set)\(/i.test(image)) return { type: "image", paint: image, layer };
    const g = parseGradient(image);
    // A two-stop gradient of one colour is how a solid rides above another
    // layer (see toLayer); read it back as the solid it is.
    if (g && isFlat(g)) return { type: "solid", paint: g.stops[0].color, layer };
    return { type: g?.kind === "radial" ? "radial" : "linear", paint: image, layer };
  }
  return { type: "solid", paint: layer.values[COLOR] ?? "", layer };
}

/**
 * Fills serialize front-first, which is CSS's own layer order. CSS keeps its
 * one `background-color` behind every image though, so only the backmost fill
 * can be a bare colour; a solid above one is written as a two-stop gradient of
 * itself, which {@link readFill} reads back as that same solid.
 */
function toLayer({ type, paint, layer }: Fill, last: boolean): Layer {
  const values = { ...layer.values };
  delete values[IMAGE];
  if (!last) delete values[COLOR];
  if (type !== "solid") values[IMAGE] = paint;
  else if (last) values[COLOR] = paint;
  else values[IMAGE] = `linear-gradient(${paint}, ${paint})`;
  return { ...layer, values };
}

/** CSS has no per-layer opacity, so a fill's opacity is its paint's alpha —
 *  and hiding a fill is that alpha at zero, which keeps the colour. An image
 *  has no alpha to set, so it has neither control. */
function opacityOf({ type, paint }: Fill): number {
  if (type === "image") return 1;
  const colour = type === "solid" ? paint : (parseGradient(paint)?.stops[0].color ?? "");
  return parseColor(colour)?.a ?? 1;
}

function withOpacity(fill: Fill, a: number): Fill {
  if (fill.type === "image") return fill;
  if (fill.type === "solid") return { ...fill, paint: withAlpha(fill.paint, a) };
  const g = parseGradient(fill.paint);
  if (!g) return fill;
  const stops = g.stops.map((s) => ({ ...s, color: withAlpha(s.color, a) }));
  return { ...fill, paint: formatGradient({ ...g, stops }) };
}

function convert(fill: Fill, type: FillType): Fill {
  const values = fill.layer.values;
  if (type === "image")
    return {
      type,
      paint: 'url("")',
      layer: {
        ...fill.layer,
        values: {
          ...values,
          [POSITION]: values[POSITION] ?? "center",
          [SIZE]: values[SIZE] ?? "cover",
          [REPEAT]: values[REPEAT] ?? "no-repeat",
        },
      },
    };
  const g =
    fill.type === "linear" || fill.type === "radial" ? parseGradient(fill.paint) : null;
  const colour =
    (g ? g.stops[0].color : fill.type === "solid" ? fill.paint : "") || DEFAULT_PAINT;
  if (type === "solid") return { ...fill, type, paint: colour };
  const stops = g?.stops ?? [
    { color: colour, pos: 0 },
    // A reference has no alpha of its own to fade, so the fade is CSS's.
    { color: refName(colour) ? "transparent" : withAlpha(colour, 0), pos: 1 },
  ];
  return {
    ...fill,
    type,
    paint: formatGradient({ kind: type, angle: g?.angle ?? 135, stops }),
  };
}

function setProp(
  patch: Patch,
  ids: Set<string>,
  prop: string,
  value: string | undefined,
) {
  patch((node) => {
    if (!ids.has(node.id)) return {};
    const style = { ...node.style };
    if (value === undefined) delete style[prop];
    else style[prop] = value;
    return { style };
  });
}

const readFills = (background: string | undefined): Fill[] =>
  parseLayers("background", background).map(readFill);

const writeFills = (fills: Fill[]): string | undefined =>
  serializeLayers(
    "background",
    fills.map((fill, i) => toLayer(fill, i === fills.length - 1)),
  ) || undefined;

export function FillSection({ selection, patch }: SectionProps) {
  const boxes = selection.filter((node) => node.kind !== "path");
  return boxes.length ? (
    <BoxFill nodes={boxes} patch={patch} />
  ) : (
    <PathFill nodes={selection} patch={patch} />
  );
}

function BoxFill({ nodes, patch }: { nodes: SceneNode[]; patch: Patch }) {
  const value = nodes[0].style.background ?? "";
  const mixed = nodes.some((node) => (node.style.background ?? "") !== value);
  const fills = mixed ? [] : readFills(value);
  const ids = new Set(nodes.map((node) => node.id));

  // Every edit is expressed against the node's *own* stack, so adding a fill to
  // a selection that disagrees prepends to each one rather than replacing them
  // all with the first node's list — which, while Mixed, is empty.
  const edit = (fn: (fills: Fill[]) => Fill[]) =>
    patch((node) => {
      if (!ids.has(node.id)) return {};
      const style = { ...node.style };
      const next = writeFills(fn(readFills(node.style.background)));
      if (next === undefined) delete style.background;
      else style.background = next;
      return { style };
    });

  return (
    <PanelSection
      title="Fill"
      onAdd={() =>
        edit((own) => [
          { type: "solid", paint: DEFAULT_PAINT, layer: { values: {} } },
          ...own,
        ])
      }
    >
      {mixed && <span className="text-muted text-[12px]">Mixed</span>}
      {fills.map((fill, i) => (
        <FillRow
          key={i}
          fill={fill}
          onChange={(next) => edit((own) => own.map((f, j) => (j === i ? next : f)))}
          onRemove={() => edit((own) => own.filter((_, j) => j !== i))}
        />
      ))}
    </PanelSection>
  );
}

function FillRow({
  fill,
  onChange,
  onRemove,
}: {
  fill: Fill;
  onChange: (fill: Fill) => void;
  onRemove: () => void;
}) {
  const opacity = opacityOf(fill);
  const image = fill.type === "image";
  const hidden = opacity === 0;
  // Opacity is the paint's alpha, and a bound paint's alpha belongs to the
  // variable — Figma greys the field out rather than detaching the reference.
  const bound = isBound(fill);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="ab-ctl-row">
        <SelectField
          value={fill.type}
          options={TYPES}
          onChange={(type) => onChange(convert(fill, type as FillType))}
        />
        <IconButton
          label={hidden ? "Show fill" : "Hide fill"}
          disabled={image || bound}
          onClick={() => onChange(withOpacity(fill, hidden ? 1 : 0))}
        >
          <Eye off={hidden} />
        </IconButton>
        <IconButton label="Remove fill" onClick={onRemove}>
          <X width={13} height={13} />
        </IconButton>
      </div>

      <div className="ab-ctl-row">
        {fill.type === "solid" ? (
          <ColorField
            value={fill.paint}
            onChange={(paint) => onChange({ ...fill, paint })}
          />
        ) : image ? (
          <input
            // Uncontrolled while you type; remounted when the value changes
            // under it, which a controlled field would need a draft state for.
            key={fill.paint}
            type="text"
            spellCheck={false}
            placeholder="Image URL"
            aria-label="Image URL"
            className="ab-ctl-text min-w-0 flex-1"
            defaultValue={srcOf(fill.paint)}
            onBlur={(e) => onChange({ ...fill, paint: toUrl(e.target.value) })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        ) : (
          <GradientField
            value={fill.paint}
            onChange={(paint) => onChange({ ...fill, paint })}
          />
        )}

        <span className="ab-ctl-narrow">
          {image ? (
            <SelectField
              value={fill.layer.values[SIZE] ?? "auto"}
              options={SIZES}
              onChange={(size) =>
                onChange({
                  ...fill,
                  layer: {
                    ...fill.layer,
                    values: {
                      ...fill.layer.values,
                      // A size is only legal in the shorthand behind a position.
                      [POSITION]: fill.layer.values[POSITION] ?? "center",
                      [SIZE]: size,
                    },
                  },
                })
              }
            />
          ) : bound ? (
            <span
              className="text-faint flex h-6 items-center px-1.5 text-[13px] tabular-nums"
              title="Opacity comes from the variable"
            >
              {Math.round(opacity * 100)}%
            </span>
          ) : (
            <NumberField
              value={Math.round(opacity * 100)}
              unit="%"
              min={0}
              max={100}
              onChange={(pct) => onChange(withOpacity(fill, pct / 100))}
            />
          )}
        </span>
      </div>
    </div>
  );
}

/** A path's fill is one SVG colour, and an undeclared one paints black — so
 *  "no fill" has to be said out loud. */
function PathFill({ nodes, patch }: { nodes: SceneNode[]; patch: Patch }) {
  const value = nodes[0].style.fill ?? "";
  const mixed = nodes.some((node) => (node.style.fill ?? "") !== value);
  const filled = value !== "" && value !== "none";
  const set = (next: string) =>
    setProp(patch, new Set(nodes.map((node) => node.id)), "fill", next);

  return (
    <PanelSection title="Fill" onAdd={filled ? undefined : () => set(DEFAULT_PAINT)}>
      {filled && (
        <div className="ab-ctl-row">
          <ColorField value={value} mixed={mixed} onChange={set} />
          <IconButton label="Remove fill" onClick={() => set("none")}>
            <X width={13} height={13} />
          </IconButton>
        </div>
      )}
    </PanelSection>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="ab-icon-btn ab-ctl-remove"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Eye({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8S4 4.25 8 4.25 14.5 8 14.5 8 12 11.75 8 11.75 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.15"
      />
      <circle cx="8" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.15" />
      {off && (
        <path
          d="M3 3 13 13"
          stroke="currentColor"
          strokeWidth="1.15"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
