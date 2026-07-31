"use client";

import { useState } from "react";
import { Check } from "@/app/components/Icons";
import { HUG, hugsOf, isAutoLayout, layoutOf } from "../../scene/autoLayout";
import { isGroup, type StyleMap, type StylePatch } from "../../scene/types";
import type { SectionProps } from "../StylePanel";
import { Field } from "../controls/Field";
import { IconToggle, type ToggleOption } from "../controls/IconToggle";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";

function merge(style: StyleMap, decls: StylePatch): StyleMap {
  const next = { ...style };
  for (const prop in decls) {
    const value = decls[prop];
    if (value === undefined) delete next[prop];
    else next[prop] = value;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

type Direction = "row" | "column" | "grid" | "none";

const DIRECTION_DECLS: Record<Direction, StylePatch> = {
  row: { display: "flex", "flex-direction": undefined },
  column: { display: "flex", "flex-direction": "column" },
  grid: { display: "grid", "flex-direction": undefined },
  none: { display: undefined, "flex-direction": undefined },
};

/** Bars in a 16px box, each `x,y,w,h`. */
function Glyph({ bars }: { bars: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {bars.split(" ").map((bar) => {
        const [x, y, w, h] = bar.split(",");
        return (
          <rect
            key={bar}
            x={x}
            y={y}
            width={w}
            height={h}
            rx="1"
            fill="currentColor"
            opacity="0.65"
          />
        );
      })}
    </svg>
  );
}

/** The toggle carries `""` as well: on a mixed selection nothing is pressed. */
const DIRECTIONS: ToggleOption<Direction | "">[] = (
  [
    { value: "row", label: "Horizontal", bars: "3,4,3,8 6.5,4,3,8 10,4,3,8" },
    { value: "column", label: "Vertical", bars: "4,3,8,3 4,6.5,8,3 4,10,8,3" },
    {
      value: "grid",
      label: "Grid",
      bars: "3,3,4.5,4.5 8.5,3,4.5,4.5 3,8.5,4.5,4.5 8.5,8.5,4.5,4.5",
    },
    { value: "none", label: "None", bars: "2.5,3,6,5 7.5,8,6,5" },
  ] as const
).map(({ value, label, bars }) => ({ value, label, icon: <Glyph bars={bars} /> }));

// ---------------------------------------------------------------------------
// The 3x3 alignment picker
// ---------------------------------------------------------------------------

const POS = ["flex-start", "center", "flex-end"] as const;
const ROW_NAMES = ["top", "middle", "bottom"];
const COL_NAMES = ["left", "centre", "right"];
const CELLS = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => ({ row, col })));

/**
 * One picker for both axes: the grid is spatial, so which of `align-items` and
 * `justify-content` a column means depends on which way the flow runs.
 */
function AlignPicker({
  horizontal,
  align,
  justify,
  onPick,
}: {
  horizontal: boolean;
  /** Index into {@link POS}, or -1 for a value the grid cannot show. */
  align: number;
  justify: number;
  onPick: (align: string, justify: string) => void;
}) {
  const onCol = horizontal ? justify : align;
  const onRow = horizontal ? align : justify;

  return (
    <div className="grid grid-cols-3 gap-px rounded-[var(--radius)] bg-[var(--sunken)] p-0.5">
      {CELLS.map(({ row, col }) => {
        const on = col === onCol && row === onRow;
        return (
          <button
            key={`${row}${col}`}
            aria-pressed={on}
            aria-label={`Align ${ROW_NAMES[row]} ${COL_NAMES[col]}`}
            title={`Align ${ROW_NAMES[row]} ${COL_NAMES[col]}`}
            onClick={() =>
              onPick(
                POS[horizontal ? row : col],
                POS[horizontal ? col : row],
              )
            }
            className={`flex size-6 items-center justify-center rounded-[var(--radius-sm)] transition-colors ${
              on
                ? "bg-[var(--background)] text-[var(--foreground)]"
                : "text-[var(--faint)] hover:bg-[var(--hover)]"
            }`}
          >
            <span
              className={
                on ? "size-1.5 rounded-[1px] bg-current" : "size-1 rounded-full bg-current"
              }
            />
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

const SIDES = [
  { key: "top", label: "T" },
  { key: "right", label: "R" },
  { key: "bottom", label: "B" },
  { key: "left", label: "L" },
] as const;

/**
 * "Hug" lives in `style` as the CSS that means it, and `scene/ops` resolves the
 * `w`/`h` the renderer paints against it on every edit. So the declaration is
 * the mode's memory as well as its mechanism, and it round-trips like every
 * other property in the grammar.
 */
const AXES = [
  { axis: "W", prop: "width", key: "w" },
  { axis: "H", prop: "height", key: "h" },
] as const;

/** A group turning auto-layout on hugs its contents, as in Figma; turning it
 *  off gives the box back to whatever size it ended up. */
const HUG_BOTH: StylePatch = { width: HUG, height: HUG };
const HUG_NEITHER: StylePatch = { width: undefined, height: undefined };

const PADDING_LONGHANDS: StylePatch = {
  "padding-top": undefined,
  "padding-right": undefined,
  "padding-bottom": undefined,
  "padding-left": undefined,
};

/** `repeat(n, …)` first, then a plain track list. */
function columnCount(spec: string): number {
  const repeat = /^repeat\(\s*(\d+)/.exec(spec.trim());
  if (repeat) return Number(repeat[1]);
  const tokens = spec.trim().split(/\s+/).filter(Boolean);
  return tokens.length || 1;
}

/** Figma's "Clip content", which is `overflow: hidden` — absent means the
 *  children may paint outside the box, and that is the default. */
function ClipToggle({
  on,
  mixed,
  onChange,
}: {
  on: boolean;
  mixed: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      role="checkbox"
      aria-checked={mixed ? "mixed" : on}
      onClick={() => onChange(!on)}
      className="flex items-center gap-2 self-start text-[length:var(--text-meta-lg)] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
    >
      <span
        className={`flex size-3.5 items-center justify-center rounded-[var(--radius-sm)] border transition-colors ${
          on && !mixed
            ? "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--background)]"
            : "border-[var(--border-strong)]"
        }`}
      >
        {mixed ? (
          <span className="h-px w-1.5 bg-[var(--faint)]" />
        ) : on ? (
          <Check width={10} height={10} />
        ) : null}
      </span>
      Clip content
    </button>
  );
}

function SidesGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="2.75"
        y="2.75"
        width="10.5"
        height="10.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray="2.5 2"
      />
    </svg>
  );
}

export function LayoutSection({ selection, patch }: SectionProps) {
  const [expanded, setExpanded] = useState(false);

  const groups = selection.filter(isGroup);
  if (groups.length === 0) return null;

  /**
   * Every write goes through here, so gaining or losing auto-layout carries its
   * default sizing with it. The box itself is not written: a hugging axis is
   * re-measured by `scene/ops` after the style lands, which is also what keeps
   * it true when a child changes later.
   */
  const write = (decls: StylePatch) =>
    patch((node) => {
      if (!isGroup(node)) return {};
      const style = merge(node.style, decls);
      const auto = isAutoLayout({ ...node, style });
      if (auto === isAutoLayout(node)) return { style };
      return { style: merge(style, auto ? HUG_BOTH : HUG_NEITHER) };
    });

  const differs = (prop: string) =>
    groups.some((g) => (g.style[prop] ?? "") !== (groups[0].style[prop] ?? ""));

  const layout = layoutOf(groups[0]);

  const clip = (
    <ClipToggle
      on={groups[0].style.overflow === "hidden"}
      mixed={differs("overflow")}
      onChange={(on) => write({ overflow: on ? "hidden" : undefined })}
    />
  );

  if (layout.mode === "none" && !differs("display")) {
    return (
      <PanelSection title="Auto layout" onAdd={() => write({ display: "flex" })}>
        {clip}
      </PanelSection>
    );
  }

  const direction: Direction =
    layout.mode === "grid"
      ? "grid"
      : layout.mode === "none"
        ? "none"
        : layout.flexDirection.startsWith("column")
          ? "column"
          : "row";
  const horizontal = direction !== "column";

  const pad = layout.padding;
  const padMixed =
    differs("padding") || SIDES.some((s) => differs(`padding-${s.key}`));
  const padUniform =
    pad.top === pad.right && pad.right === pad.bottom && pad.bottom === pad.left;

  const setPadding = (n: number) =>
    write({ padding: n === 0 ? undefined : `${n}px`, ...PADDING_LONGHANDS });
  const setSide = (side: (typeof SIDES)[number]["key"], n: number) => {
    const next = { ...pad, [side]: n };
    write({
      padding: `${next.top}px ${next.right}px ${next.bottom}px ${next.left}px`,
      ...PADDING_LONGHANDS,
    });
  };

  return (
    <PanelSection title="Auto layout">
      <Field label="Direction">
        <IconToggle
          value={differs("display") || differs("flex-direction") ? "" : direction}
          options={DIRECTIONS}
          onChange={(value) => {
            if (value) write(DIRECTION_DECLS[value]);
          }}
        />
      </Field>

      <div className="grid grid-cols-2 gap-1.5">
        <NumberField
          label="Gap"
          value={layout.gap}
          mixed={differs("gap")}
          min={0}
          onChange={(n) => write({ gap: n === 0 ? undefined : `${n}px` })}
        />
        <div className="flex min-w-0 items-center gap-0.5">
          <div className="min-w-0 flex-1">
            <NumberField
              label="Pad"
              value={pad.top}
              mixed={padMixed || (!expanded && !padUniform)}
              min={0}
              onChange={setPadding}
            />
          </div>
          <button
            className={`ab-icon-btn size-6${expanded ? " text-[var(--foreground)]" : ""}`}
            aria-pressed={expanded}
            aria-label="Independent padding"
            title="Independent padding"
            onClick={() => setExpanded((v) => !v)}
          >
            <SidesGlyph />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="grid grid-cols-2 gap-1.5">
          {SIDES.map((side) => (
            <NumberField
              key={side.key}
              label={side.label}
              value={pad[side.key]}
              mixed={padMixed}
              min={0}
              onChange={(n) => setSide(side.key, n)}
            />
          ))}
        </div>
      )}

      <Field label="Align">
        <AlignPicker
          horizontal={horizontal}
          align={POS.findIndex((p) => p === layout.alignItems)}
          justify={POS.findIndex((p) => p === layout.justifyContent)}
          onPick={(align, justify) =>
            write({
              "align-items": align === "flex-start" ? undefined : align,
              "justify-content": justify === "flex-start" ? undefined : justify,
            })
          }
        />
      </Field>

      {direction === "grid" && (
        <Field label="Columns">
          <NumberField
            value={columnCount(layout.gridTemplateColumns)}
            mixed={differs("grid-template-columns")}
            min={1}
            onChange={(n) =>
              write({ "grid-template-columns": `repeat(${Math.round(n)}, auto)` })
            }
          />
        </Field>
      )}

      <Field label="Resize">
        <div className="flex gap-1.5">
          {AXES.map(({ axis, prop, key }) => (
            <SelectField
              key={prop}
              value={hugsOf(groups[0])[key] ? "hug" : "fixed"}
              options={[
                { value: "fixed", label: `${axis}: Fixed` },
                { value: "hug", label: `${axis}: Hug` },
              ]}
              onChange={(mode) => write({ [prop]: mode === "hug" ? HUG : undefined })}
            />
          ))}
        </div>
      </Field>

      {clip}
    </PanelSection>
  );
}
