"use client";

import { useState } from "react";
import { Tooltip } from "@/app/components/Tooltip";
import { HUG, hugsOf, isAutoLayout, layoutOf } from "../../scene/autoLayout";
import { isGroup, type StyleMap, type StylePatch } from "../../scene/types";
import type { SectionProps } from "../StylePanel";
import {
  FlowColumn,
  FlowGrid,
  FlowNone,
  FlowRow,
  Gap,
  PadAll,
  PadSide,
} from "../controls/glyphs";
import { IconToggle, type ToggleOption } from "../controls/IconToggle";
import { NumberField } from "../controls/NumberField";
import { CheckRow, PanelSection } from "../controls/PanelSection";
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

const DIRECTIONS: ToggleOption<Direction>[] = [
  { value: "row", label: "Stack horizontally", icon: <FlowRow /> },
  { value: "column", label: "Stack vertically", icon: <FlowColumn /> },
  { value: "grid", label: "Arrange in a grid", icon: <FlowGrid /> },
  { value: "none", label: "Place freely", icon: <FlowNone /> },
];

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
 *
 * Framed as a well and left at its natural square, so it reads as the box the
 * children are being placed inside. It used to be nine bare cells whose whole
 * content was a 4px dot in `--faint` — the least discoverable control here.
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
    <div className="nt-ctl-align3" role="group" aria-label="Align contents">
      {CELLS.map(({ row, col }) => {
        const on = col === onCol && row === onRow;
        const name = `Align ${ROW_NAMES[row]} ${COL_NAMES[col]}`;
        return (
          <Tooltip key={`${row}${col}`} label={name} className="nt-ctl-anchor">
            <button
              aria-pressed={on}
              aria-label={name}
              onClick={() =>
                onPick(POS[horizontal ? row : col], POS[horizontal ? col : row])
              }
              className="nt-ctl-align3-cell"
            >
              <span className={on ? "nt-ctl-align3-on" : "nt-ctl-align3-off"} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Padding, drawn rather than initialled. The letters used to be T/R/B/L, and
 *  that "R" sat one section away from an "R" that meant rotation. */
const SIDES = [
  { key: "top", name: "Top padding", icon: <PadSide side="top" /> },
  { key: "right", name: "Right padding", icon: <PadSide side="right" /> },
  { key: "bottom", name: "Bottom padding", icon: <PadSide side="bottom" /> },
  { key: "left", name: "Left padding", icon: <PadSide side="left" /> },
] as const;

/**
 * "Hug" lives in `style` as the CSS that means it, and `scene/ops` resolves the
 * `w`/`h` the renderer paints against it on every edit. So the declaration is
 * the mode's memory as well as its mechanism, and it round-trips like every
 * other property in the grammar.
 */
const AXES = [
  { axis: "W", name: "Width behaviour", prop: "width", key: "w" },
  { axis: "H", name: "Height behaviour", prop: "height", key: "h" },
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
    <CheckRow
      label="Clip content"
      on={groups[0].style.overflow === "hidden"}
      mixed={differs("overflow")}
      onChange={(on) => write({ overflow: on ? "hidden" : undefined })}
    />
  );

  if (layout.mode === "none" && !differs("display")) {
    return (
      <PanelSection
        title="Auto layout"
        onAdd={() => write({ display: "flex" })}
        addLabel="Add auto layout"
      >
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
      <div className="nt-ctl-group">
        <div className="nt-ctl-row">
          <IconToggle
            value={differs("display") || differs("flex-direction") ? "" : direction}
            options={DIRECTIONS}
            onChange={(value) => write(DIRECTION_DECLS[value])}
          />
        </div>

        <div className="nt-ctl-grid">
          <NumberField
            label={<Gap />}
            name="Gap between items"
            value={layout.gap}
            mixed={differs("gap")}
            min={0}
            onChange={(n) => write({ gap: n === 0 ? undefined : `${n}px` })}
          />
          <NumberField
            label={<PadAll />}
            name="Padding"
            value={pad.top}
            mixed={padMixed || (!expanded && !padUniform)}
            min={0}
            onChange={setPadding}
          />
          <Tooltip label="Set each side separately" className="nt-ctl-slot">
            <button
              className="nt-icon-btn is-sm"
              aria-pressed={expanded}
              aria-label="Set each side separately"
              onClick={() => setExpanded((v) => !v)}
            >
              <PadSide side="left" />
            </button>
          </Tooltip>
        </div>

        {expanded &&
          [SIDES.slice(0, 2), SIDES.slice(2)].map((pair) => (
            <div className="nt-ctl-grid" key={pair[0].key}>
              {pair.map((side) => (
                <NumberField
                  key={side.key}
                  label={side.icon}
                  name={side.name}
                  value={pad[side.key]}
                  mixed={padMixed}
                  min={0}
                  onChange={(n) => setSide(side.key, n)}
                />
              ))}
            </div>
          ))}
      </div>

      <div className="nt-ctl-group">
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

        {direction === "grid" && (
          <div className="nt-ctl-grid">
            <NumberField
              label="Cols"
              name="Grid columns"
              value={columnCount(layout.gridTemplateColumns)}
              mixed={differs("grid-template-columns")}
              min={1}
              onChange={(n) =>
                write({
                  "grid-template-columns": `repeat(${Math.round(n)}, auto)`,
                })
              }
            />
          </div>
        )}

        <div className="nt-ctl-grid">
          {AXES.map(({ axis, name, prop, key }) => (
            <SelectField
              key={prop}
              label={axis}
              value={hugsOf(groups[0])[key] ? "hug" : "fixed"}
              options={[
                { value: "fixed", label: "Fixed" },
                { value: "hug", label: "Hug" },
              ]}
              name={name}
              onChange={(mode) =>
                write({ [prop]: mode === "hug" ? HUG : undefined })
              }
            />
          ))}
        </div>

        {clip}
      </div>
    </PanelSection>
  );
}
