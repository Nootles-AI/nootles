"use client";

import { useState } from "react";
import { Tooltip } from "@/app/components/Tooltip";
import { LENGTH_UNITS, NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import type { SceneNode } from "../../scene/types";
import { parseComposite, serializeComposite } from "../cssCatalog";
import type { SectionProps } from "../StylePanel";

type Read = { value: number; mixed: boolean };

function read(nodes: SceneNode[], pick: (node: SceneNode) => number): Read {
  const first = pick(nodes[0]);
  return { value: first, mixed: nodes.some((n) => pick(n) !== first) };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The four corners as CSS wrote them — `12px`, `50%`, `1em` — clockwise from
 *  the top left. A number alone cannot say which of those it was. */
type Corners = [string, string, string, string];

const CORNER_PROPS = [
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
] as const;

const CORNER_LABELS = ["TL", "TR", "BR", "BL"];

/** Read in CSS order, shown in reading order — the second row is BL then BR. */
const CORNER_ORDER = [0, 1, 3, 2];

/**
 * `border-radius` splits at a `/` into horizontal and vertical radii. Only the
 * horizontal half is editable here; the vertical half is carried through
 * untouched rather than being collapsed away by an edit to the other one.
 */
function splitRadius(value: string): [string, string | null] {
  const at = value.indexOf("/");
  return at < 0
    ? [value, null]
    : [value.slice(0, at).trim(), value.slice(at + 1).trim()];
}

function parseCorners(value: string): Corners {
  const values = parseComposite("border-radius", splitRadius(value)[0]).values;
  return CORNER_PROPS.map((prop) => values[prop] || "0") as Corners;
}

function cornerCss(corners: Corners, vertical: string | null): string | undefined {
  const values: Record<string, string> = {};
  CORNER_PROPS.forEach((prop, i) => (values[prop] = corners[i]));
  const css = serializeComposite("border-radius", { values });
  if (vertical) return `${css} / ${vertical}`;
  return css === "0" ? undefined : css;
}

const px = (value: string) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A scrubbed number keeps whatever unit the value already carried. Anything
 * that is not a unit — a `calc()`, a `var()` — reads as px, which is what the
 * number beside it already fell back to.
 */
const unitOf = (value: string) => {
  const unit = value.replace(/^[-\d.]+/, "").toLowerCase();
  return (LENGTH_UNITS as readonly string[]).includes(unit) ? unit : "px";
};

function LinkGlyph({ on }: { on: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6.5 4.5h-1a3 3 0 0 0 0 6h1M9.5 4.5h1a3 3 0 0 1 0 6h-1"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      {on && (
        <path d="M6 7.5h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * Kinds `border-radius` cannot reach. A plain ellipse *is* a border radius, and
 * an arc ellipse and a path are both drawn as SVG paths — the property is
 * declared but nothing reads it, so the field would be a lie. A polygon is not
 * here: its radius rounds the vertices, deliberately.
 */
const NO_RADIUS: ReadonlySet<string> = new Set(["ellipse", "path"]);

function CornerGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 13.5V7a4 4 0 0 1 4-4h6.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PositionSection({ selection, patch, setStyle }: SectionProps) {
  const [linked, setLinked] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const x = read(selection, (n) => n.x);
  const y = read(selection, (n) => n.y);
  const w = read(selection, (n) => n.w);
  const h = read(selection, (n) => n.h);
  const rot = read(selection, (n) => n.rot);

  const radius = selection[0].style["border-radius"] ?? "";
  const radiusMixed = selection.some(
    (n) => (n.style["border-radius"] ?? "") !== radius,
  );
  const vertical = splitRadius(radius)[1];
  const corners = parseCorners(radius);
  const uniform = corners.every((c) => c === corners[0]);
  // A polygon's radius rounds its vertices, not four box corners, so there is
  // no TL/BR for the split control to name (see `render/svgShape`). It reads
  // the first value of the shorthand, which is what the single field writes.
  const perCorner = !selection.some((n) => n.kind === "polygon");
  // A mixed selection keeps the field and simply passes over the kinds that
  // ignore it; only a selection that is entirely radius-less drops it.
  const rounds = selection.some((n) => !NO_RADIUS.has(n.kind));
  const independent = rounds && perCorner && expanded;

  const setCorner = (index: number, value: number, unit: string) => {
    const next = [...corners] as Corners;
    next[index] = `${value}${unit}`;
    setStyle({ "border-radius": cornerCss(next, vertical) });
  };

  // The link scales the other axis by the ratio each node already has, so a
  // multi-selection of different proportions keeps every one of them.
  const setWidth = (value: number) =>
    patch((node) =>
      linked && node.w
        ? { w: value, h: round((node.h * value) / node.w) }
        : { w: value },
    );
  const setHeight = (value: number) =>
    patch((node) =>
      linked && node.h
        ? { h: value, w: round((node.w * value) / node.h) }
        : { h: value },
    );

  return (
    <PanelSection title="Position">
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField
          label="X"
          value={x.value}
          mixed={x.mixed}
          onChange={(n) => patch(() => ({ x: n }))}
        />
        <NumberField
          label="Y"
          value={y.value}
          mixed={y.mixed}
          onChange={(n) => patch(() => ({ y: n }))}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
          <NumberField
            label="W"
            value={w.value}
            mixed={w.mixed}
            min={1}
            onChange={setWidth}
          />
          <NumberField
            label="H"
            value={h.value}
            mixed={h.mixed}
            min={1}
            onChange={setHeight}
          />
        </div>
        <Tooltip label="Lock aspect ratio">
          <button
            className={`ab-icon-btn size-6${linked ? " text-[var(--foreground)]" : ""}`}
            aria-pressed={linked}
            aria-label="Lock aspect ratio"
            onClick={() => setLinked((v) => !v)}
          >
            <LinkGlyph on={linked} />
          </button>
        </Tooltip>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <NumberField
          label="R"
          unit="°"
          value={rot.value}
          mixed={rot.mixed}
          onChange={(n) => patch(() => ({ rot: n }))}
        />
        {rounds && (
          <div className="flex min-w-0 items-center gap-0.5">
            <div className="min-w-0 flex-1">
              <NumberField
                label="C"
                value={px(corners[0])}
                unit={unitOf(corners[0])}
                units={LENGTH_UNITS}
                mixed={radiusMixed || (!independent && !uniform)}
                min={0}
                onChange={(n, u) =>
                  setStyle({ "border-radius": n === 0 ? undefined : `${n}${u}` })
                }
              />
            </div>
            {perCorner && (
              <Tooltip label="Independent corners">
                <button
                  className={`ab-icon-btn size-6${expanded ? " text-[var(--foreground)]" : ""}`}
                  aria-pressed={expanded}
                  aria-label="Independent corners"
                  onClick={() => setExpanded((v) => !v)}
                >
                  <CornerGlyph />
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {independent && (
        <div className="grid grid-cols-2 gap-1.5">
          {CORNER_ORDER.map((i) => (
            <NumberField
              key={CORNER_LABELS[i]}
              label={CORNER_LABELS[i]}
              value={px(corners[i])}
              unit={unitOf(corners[i])}
              units={LENGTH_UNITS}
              mixed={radiusMixed}
              min={0}
              onChange={(n, u) => setCorner(i, n, u)}
            />
          ))}
        </div>
      )}
    </PanelSection>
  );
}
