"use client";

import { useRef, useState } from "react";
import { useConvex } from "convex/react";
import { Image as ImageGlyph, X } from "@/app/components/Icons";
import { Tooltip } from "@/app/components/Tooltip";
import { putImage } from "../../../album/upload";
import type { SceneNode } from "../../scene/types";
import { isBoolean } from "../../scene/types";
import { ColorField } from "../controls/ColorField";
import { Eye } from "../controls/glyphs";
import { IconButton } from "../controls/IconButton";
import { GradientField } from "../controls/GradientField";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import {
  DEFAULT_PAINT,
  POSITION,
  SIZE,
  convert,
  isBound,
  opacityOf,
  readFills,
  withOpacity,
  writeFills,
  type Fill,
  type FillType,
} from "../fills";
import { parseGradient } from "../controls/gradient";
import type { SectionProps } from "../StylePanel";

type Patch = SectionProps["patch"];

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

const srcOf = (paint: string) => paint.replace(/^url\(\s*["']?|["']?\s*\)$/g, "");
const toUrl = (src: string) => `url("${src.replace(/"/g, "%22")}")`;

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

export function FillSection({ selection, patch }: SectionProps) {
  const boxes = selection.filter((node) => node.kind !== "path" && !isBoolean(node));
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
      {mixed && <span className="nt-ctl-empty">Mixed</span>}
      {!mixed && fills.length === 0 && (
        <span className="nt-ctl-empty">No fill</span>
      )}
      {fills.map((fill, i) => (
        <FillRow
          key={i}
          fill={fill}
          onChange={(next) =>
            edit((own) => own.map((f, j) => (j === i ? next : f)))
          }
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
    <div className="nt-ctl-group">
      <div className="nt-ctl-row">
        <SelectField
          name="Fill type"
          value={fill.type}
          options={TYPES}
          onChange={(type) => onChange(convert(fill, type as FillType))}
        />
        <IconButton
          label={hidden ? "Show fill" : "Hide fill"}
          disabled={image || bound}
          onClick={() => onChange(withOpacity(fill, hidden ? 1 : 0))}
        >
          <Eye off={hidden} width={15} height={15} />
        </IconButton>
        <IconButton label="Remove fill" onClick={onRemove}>
          <X width={13} height={13} />
        </IconButton>
      </div>

      <div className="nt-ctl-row">
        {fill.type === "solid" ? (
          <ColorField
            value={fill.paint}
            accepts="paint"
            onChange={(paint) => {
              // A Shift-pick can hand this field a whole gradient (`accepts`
              // says it may) — that converts the row to that gradient kind
              // rather than trying to store a gradient string as a solid.
              const g = parseGradient(paint);
              onChange(g ? { ...fill, type: g.kind, paint } : { ...fill, paint });
            }}
          />
        ) : image ? (
          <ImagePicker src={srcOf(fill.paint)} onPick={(src) => onChange({ ...fill, paint: toUrl(src) })} />
        ) : (
          <GradientField
            value={fill.paint}
            onChange={(paint) => onChange({ ...fill, paint })}
          />
        )}

        <span className="nt-ctl-narrow">
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
            <Tooltip
              label="Opacity comes from the variable"
              className="nt-ctl-anchor"
            >
              <span className="nt-ctl-bound">{Math.round(opacity * 100)}%</span>
            </Tooltip>
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
    <PanelSection
      title="Fill"
      onAdd={filled ? undefined : () => set(DEFAULT_PAINT)}
    >
      {filled ? (
        <div className="nt-ctl-row">
          <ColorField value={value} mixed={mixed} onChange={set} />
          <IconButton label="Remove fill" onClick={() => set("none")}>
            <X width={13} height={13} />
          </IconButton>
        </div>
      ) : (
        <span className="nt-ctl-empty">No fill</span>
      )}
    </PanelSection>
  );
}

/**
 * The image behind an image fill: a picture you choose, not an address you
 * paste. It goes up through the album's pipeline — re-encoded at screen size,
 * stored where the page's other pictures are — and the fill holds the
 * permanent URL that comes back, which is the one thing a `url()` in the
 * grammar was ever going to be.
 */
function ImagePicker({ src, onPick }: { src: string; onPick: (src: string) => void }) {
  const convex = useConvex();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailure(null);
    try {
      onPick(await putImage(convex, file));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "That picture didn't upload.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <button
        type="button"
        className="nt-ctl-swatch min-w-0 flex-1"
        aria-label={src ? "Replace image" : "Choose image"}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <span className="nt-ctl-mark" aria-hidden>
          {src ? (
            // The picture itself, at swatch size: what a colour swatch is to a
            // colour, this is to an image.
            <span className="nt-ctl-thumb" style={{ backgroundImage: toUrl(src) }} />
          ) : (
            <ImageGlyph width={14} height={14} />
          )}
        </span>
        <span className="nt-ctl-swatch-text">
          {busy ? "Uploading…" : failure ? failure : src ? "Replace image" : "Choose image"}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        hidden
        onChange={(e) => void take(e.target.files?.[0])}
      />
    </>
  );
}
