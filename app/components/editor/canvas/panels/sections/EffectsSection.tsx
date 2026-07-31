"use client";

import type { ReactNode } from "react";
import { X } from "@/app/components/Icons";
import type { StyleMap } from "../../scene/types";
import { ColorField } from "../controls/ColorField";
import { Blur, Eye, Spread } from "../controls/glyphs";
import { IconButton } from "../controls/IconButton";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import {
  blankLayer,
  parseLayers,
  serializeLayers,
  type Layer,
} from "../cssCatalog";
import type { SectionProps } from "../StylePanel";

type FxType = "drop" | "inner" | "blur" | "backdrop";
type FxStack = "box-shadow" | "filter" | "backdrop-filter";

/** One row of the list. `layer` is a layer of the stack `STACK[type]` names. */
type Fx = { type: FxType; layer: Layer; hidden: boolean };

const TYPES = [
  { value: "drop", label: "Drop shadow" },
  { value: "inner", label: "Inner shadow" },
  { value: "blur", label: "Layer blur" },
  { value: "backdrop", label: "Background blur" },
];

const STACKS = ["box-shadow", "filter", "backdrop-filter"] as const;

const STACK: Record<FxType, FxStack> = {
  drop: "box-shadow",
  inner: "box-shadow",
  blur: "filter",
  backdrop: "backdrop-filter",
};

const BLUR_TYPE = { filter: "blur", "backdrop-filter": "backdrop" } as const;

/**
 * Where a hidden effect waits. CSS has no "off" for one layer of a stack, and
 * dropping the declaration would lose exactly the values the eye promises to
 * give back. A custom property is real CSS, is inert to the renderer, and
 * round-trips through the grammar untouched. The cost is that re-showing an
 * effect returns it to the end of its own stack rather than its old position.
 */
const off = (stack: FxStack) => `--ab-off-${stack}`;

const isBlur = (stack: FxStack, layer: Layer) =>
  layer.values[`${stack}-fn`] === "blur";

function readFx(style: StyleMap): Fx[] {
  const out: Fx[] = [];
  const take = (stack: FxStack, hidden: boolean) => {
    for (const layer of parseLayers(stack, style[hidden ? off(stack) : stack])) {
      if (stack === "box-shadow")
        out.push({
          type: layer.values["box-shadow-type"] === "inset" ? "inner" : "drop",
          layer,
          hidden,
        });
      else if (isBlur(stack, layer))
        out.push({ type: BLUR_TYPE[stack], layer, hidden });
    }
  };
  for (const stack of STACKS) {
    take(stack, false);
    take(stack, true);
  }
  return out;
}

/**
 * The blurs this section owns, put back where the ones they replace already
 * were. `filter` functions compose in order — blur-then-brighten does not paint
 * the same as brighten-then-blur — so a stack the panel did not reorder must
 * come back out in the order it was authored in, including the
 * brightness/contrast/saturate/grayscale layers the appearance section owns.
 */
function merge(stack: FxStack, was: Layer[], blurs: Layer[]): Layer[] {
  const out: Layer[] = [];
  let i = 0;
  for (const layer of was) {
    if (!isBlur(stack, layer)) out.push(layer);
    else if (i < blurs.length) out.push(blurs[i++]);
  }
  return [...out, ...blurs.slice(i)];
}

function writeFx(style: StyleMap, fx: Fx[]): StyleMap {
  const next = { ...style };
  const put = (prop: string, value: string) => {
    // An unchanged stack is left exactly as it was authored: re-serializing it
    // would churn the document on every unrelated Effects click.
    if (value === (style[prop] ?? "")) return;
    if (value) next[prop] = value;
    else delete next[prop];
  };
  for (const stack of STACKS) {
    const mine = (hidden: boolean) =>
      fx
        .filter((f) => STACK[f.type] === stack && f.hidden === hidden)
        .map((f) => f.layer);
    const visible =
      stack === "box-shadow"
        ? mine(false)
        : merge(stack, parseLayers(stack, style[stack]), mine(false));
    put(stack, serializeLayers(stack, visible));
    put(off(stack), serializeLayers(stack, mine(true)));
  }
  return next;
}

function retype(fx: Fx, type: FxType): Fx {
  const to = STACK[type];
  const from = STACK[fx.type];
  if (from === to) {
    if (to !== "box-shadow") return fx;
    const values = { ...fx.layer.values };
    if (type === "inner") values["box-shadow-type"] = "inset";
    else delete values["box-shadow-type"];
    return { ...fx, type, layer: { ...fx.layer, values } };
  }
  const blank = blankLayer(to);
  // A blur is a blur whichever surface it lands on, so carry the radius across.
  const radius = from === "box-shadow" ? "" : fx.layer.values[`${from}-value`];
  return {
    ...fx,
    type,
    layer:
      to === "box-shadow" || !radius
        ? blank
        : { values: { ...blank.values, [`${to}-value`]: radius } },
  };
}

const withValue = (fx: Fx, key: string, value: string): Fx => ({
  ...fx,
  layer: { ...fx.layer, values: { ...fx.layer.values, [key]: value } },
});

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function EffectsSection({ selection, patch }: SectionProps) {
  const lists = selection.map((node) => readFx(node.style));
  const shape = (fx: Fx[]) =>
    fx.map((f) => `${f.type}${f.hidden ? "!" : ""}`).join();
  const aligned = lists.every((l) => shape(l) === shape(lists[0]));

  const edit = (fn: (fx: Fx[]) => Fx[]) =>
    patch((node) => ({ style: writeFx(node.style, fn(readFx(node.style))) }));
  const at = (i: number, fn: (fx: Fx) => Fx) =>
    edit((list) => list.map((f, j) => (j === i ? fn(f) : f)));

  const read = (i: number, key: string) => lists[0][i].layer.values[key] ?? "";
  const differs = (i: number, key: string) =>
    lists.some((l) => (l[i].layer.values[key] ?? "") !== read(i, key));

  return (
    <PanelSection
      title="Effects"
      onAdd={() =>
        edit((list) => [
          ...list,
          { type: "drop", layer: blankLayer("box-shadow"), hidden: false },
        ])
      }
    >
      {!aligned ? (
        <span className="ab-ctl-empty">Mixed</span>
      ) : lists[0].length === 0 ? (
        <span className="ab-ctl-empty">No effects</span>
      ) : (
        lists[0].map((fx, i) => {
          const stack = STACK[fx.type];
          const number = (
            key: string,
            label: ReactNode,
            name: string,
            min?: number,
          ) => (
            <NumberField
              label={label}
              name={name}
              value={px(read(i, key))}
              mixed={differs(i, key)}
              unit="px"
              min={min}
              onChange={(n) => at(i, (f) => withValue(f, key, `${n}px`))}
            />
          );

          return (
            <div key={i} className="ab-ctl-group">
              <div className="ab-ctl-row">
                <SelectField
                  name="Effect type"
                  value={fx.type}
                  options={TYPES}
                  onChange={(type) => at(i, (f) => retype(f, type as FxType))}
                />
                <IconButton
                  label={fx.hidden ? "Show effect" : "Hide effect"}
                  onClick={() => at(i, (f) => ({ ...f, hidden: !f.hidden }))}
                >
                  <Eye off={fx.hidden} />
                </IconButton>
                <IconButton
                  label="Remove effect"
                  onClick={() => edit((list) => list.filter((_, j) => j !== i))}
                >
                  <X width={13} height={13} />
                </IconButton>
              </div>

              <div className={`ab-ctl-stack${fx.hidden ? " is-off" : ""}`}>
                {stack === "box-shadow" ? (
                  <>
                    <div className="ab-ctl-grid">
                      {number("box-shadow-h", "X", "Offset X")}
                      {number("box-shadow-v", "Y", "Offset Y")}
                    </div>
                    <div className="ab-ctl-grid">
                      {number("box-shadow-blur", <Blur />, "Blur radius", 0)}
                      {number("box-shadow-spread", <Spread />, "Spread")}
                    </div>
                    <div className="ab-ctl-row">
                      <ColorField
                        value={read(i, "box-shadow-color")}
                        mixed={differs(i, "box-shadow-color")}
                        onChange={(color) =>
                          at(i, (f) => withValue(f, "box-shadow-color", color))
                        }
                      />
                    </div>
                  </>
                ) : (
                  <div className="ab-ctl-grid">
                    {number(`${stack}-value`, <Blur />, "Blur radius", 0)}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </PanelSection>
  );
}
