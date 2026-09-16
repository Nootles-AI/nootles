import { describe, expect, it } from "vitest";

import { opacityOf, readFills } from "../panels/fills";
import { readStroke } from "../panels/strokes";
import { alphaOf, edgeBands, fillVisible } from "./paint";
import type { NodeId, RectNode, StyleMap } from "./types";

/**
 * Wave 5 close-out (build-plan Conflict 5 / OQ-5): PICK's picking-policy
 * readers (`fillVisible`, `edgeBands`, both in `scene/paint.ts`) and COLOR's
 * panel readers (`readFills`/`opacityOf` in `panels/fills.ts`, `readStroke`
 * in `panels/strokes.ts`) independently answer the same two questions —
 * "does this box have visible fill" and "does this box have a visible
 * border" — from the same CSS. They were written separately because they
 * serve different callers (a hit test vs. an editable panel row) and were
 * never required to share an implementation, but if they silently disagreed
 * on an edge case, a shape could be clickable-but-not-shown-as-filled in the
 * inspector, or the reverse. This file is the standing guard against that
 * drift, run against the same representative style table `paint.test.ts`'s
 * own `fillVisible`/`edgeBands` suites already exercise for PICK.
 *
 * Restricted to the `background` shorthand and `border`/`outline` shorthands
 * — the only spellings COLOR's own FillSection/StrokeSection ever read or
 * write. `fillVisible`'s longhand-only rows (`background-color` alone,
 * `background-image` alone) have no COLOR-side equivalent to cross-check
 * against and are intentionally excluded, not silently dropped: COLOR always
 * writes the shorthand, so a longhand-only document is off both panels'
 * beaten path already.
 */

const rect = (style: StyleMap): RectNode => ({
  id: "x" as NodeId,
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rot: 0,
  style,
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
  kind: "rect",
});

/** COLOR's own answer to "does this background paint anything visible". */
function colorSaysFillVisible(background: string | undefined): boolean {
  if (background === undefined) return false;
  return readFills(background).some((fill) => fill.type === "image" || opacityOf(fill) > 0);
}

/** COLOR's own answer to "does this box have a visible border/outline". */
function colorSaysStrokeVisible(style: StyleMap): boolean {
  const stroke = readStroke(rect(style));
  return stroke !== null && stroke.width > 0 && alphaOf(stroke.color) > 0;
}

describe("fillVisible agrees with readFills/opacityOf (build-plan Conflict 5)", () => {
  it.each([
    [undefined],
    ["#fff"],
    ["transparent"],
    ["rgba(0,0,0,0)"],
    ["rgb(0 0 0 / 0%)"],
    ["#0000"],
    ["#00000000"],
    ["oklch(0.93 0.003 90)"],
    ["var(--brand)"],
    ["linear-gradient(transparent, transparent)"],
    ["linear-gradient(135deg, #f00, rgba(0,0,0,0))"],
    ["linear-gradient(135deg, rgba(1,2,3,0) 0%, transparent 100%), #fff"],
    ["linear-gradient(transparent, transparent), transparent"],
    ['url("x.png") center/cover no-repeat'],
    ["none"],
  ])("agrees on background: %s", (background) => {
    const style: StyleMap = background === undefined ? {} : { background };
    expect(fillVisible(style, false)).toBe(colorSaysFillVisible(background));
  });
});

describe("edgeBands agrees with readStroke/alphaOf (build-plan Conflict 5)", () => {
  it.each([
    [{}],
    [{ border: "2px solid #111" }],
    [{ border: "solid red" }],
    [{ border: "2px #111" }],
    [{ border: "2px solid transparent" }],
    [{ border: "0px solid #111" }],
    [{ border: "2px solid" }],
    [{ border: "2px solid #111", "border-width": "6px" }],
    [{ "border-width": "2px", "border-style": "dashed", "border-color": "#111" }],
    [{ outline: "2px solid #111" }],
    [{ outline: "2px solid #111", "outline-offset": "-1px" }],
    [{ border: "2px solid rgba(0,0,0,0)" }],
    [{ outline: "2px solid rgba(17,17,17,.5)" }],
  ] as StyleMap[][])("agrees on style: %o", (style) => {
    expect(edgeBands(style).length > 0).toBe(colorSaysStrokeVisible(style));
  });
});
