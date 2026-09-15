import { describe, expect, it } from "vitest";

import { alphaOf, drawnStrokeWidth, edgeBands, fillVisible, layers } from "./paint";
import type { StyleMap } from "./types";

/**
 * Table-driven coverage for the picking-policy readers PICK added to this
 * module: is a fill visible (§3.1), where do a box's rings sit (§3.2), and
 * how wide does an SVG-drawn kind's stroke paint, including the drawn-kind
 * default-ink band (§3.3). Every row here is independently re-derivable from
 * the CSS spelling alone — no scene, no DOM — which is what makes them a
 * fast, tight ring around `scene/picking.ts`'s own fixture-driven tests.
 */

describe("layers", () => {
  it("splits on top-level commas, leaving a function's own commas whole", () => {
    expect(layers("rgba(0, 0, 0, .2), #fff")).toEqual(["rgba(0, 0, 0, .2)", "#fff"]);
    expect(layers("")).toEqual([]);
    expect(layers("none")).toEqual(["none"]);
    expect(layers("linear-gradient(135deg, red, blue), url(x.png)")).toEqual([
      "linear-gradient(135deg, red, blue)",
      "url(x.png)",
    ]);
  });
});

describe("alphaOf", () => {
  it.each([
    ["#fff", 1],
    ["#ffff", 1],
    ["#0000", 0],
    ["#ffffff", 1],
    ["#ffffff00", 0],
    ["#ffffffff", 1],
    ["rgb(0, 0, 0)", 1],
    ["rgba(0, 0, 0, .2)", 0.2],
    ["rgba(0, 0, 0, 0)", 0],
    ["rgb(0 0 0 / 20%)", 0.2],
    ["rgb(0 0 0 / 0%)", 0],
    ["hsl(0, 0%, 0%)", 1],
    ["hsla(0, 0%, 0%, 0.5)", 0.5],
    ["oklch(0.93 0.003 90)", 1],
    ["oklch(0.7 0.1 145 / 50%)", 0.5],
    ["color(display-p3 0 0 0 / .5)", 0.5],
    ["transparent", 0],
    ["none", 0],
    ["var(--brand)", 1],
    ["red", 1],
    ["currentColor", 1],
    ["not a colour at all", 1],
  ])("alphaOf(%s) === %s", (token, expected) => {
    expect(alphaOf(token)).toBeCloseTo(expected, 5);
  });
});

describe("fillVisible", () => {
  it.each([
    [{}, false],
    [{ background: "#fff" }, true],
    [{ background: "transparent" }, false],
    [{ background: "rgba(0,0,0,0)" }, false],
    [{ background: "rgb(0 0 0 / 0%)" }, false],
    [{ background: "#0000" }, false],
    [{ background: "#00000000" }, false],
    [{ background: "oklch(0.93 0.003 90)" }, true],
    [{ background: "var(--brand)" }, true],
    [{ background: "linear-gradient(transparent, transparent)" }, false],
    [{ background: "linear-gradient(135deg, #f00, rgba(0,0,0,0))" }, true],
    [{ background: "linear-gradient(135deg, rgba(1,2,3,0) 0%, transparent 100%), #fff" }, true],
    [{ background: "linear-gradient(transparent, transparent), transparent" }, false],
    [{ background: 'url("x.png") center/cover no-repeat' }, true],
    [{ background: "none" }, false],
    [{ "background-color": "#fff" }, true],
    [{ "background-image": "radial-gradient(#000, #000)" }, true],
    [{ "background-image": "none" }, false],
    [{ "box-shadow": "0 2px 8px #000" }, false],
    [{ opacity: "0", background: "#fff" }, true],
  ] as [StyleMap, boolean][])("fillVisible(%o, false) === %s", (style, expected) => {
    expect(fillVisible(style, false)).toBe(expected);
  });

  it("a path/boolean's fill string is read literally, alpha-aware", () => {
    // §3.3's blocker fix: fillVisible IS alpha-aware for drawn kinds (unlike
    // drawnStrokeWidth's literal check below) — a fully transparent authored
    // fill is genuinely invisible paint.
    expect(fillVisible({ fill: "rgba(0,0,0,0)" }, true)).toBe(false);
    expect(fillVisible({ fill: "none" }, true)).toBe(false);
    expect(fillVisible({}, true)).toBe(false);
    expect(fillVisible({ fill: "#000" }, true)).toBe(true);
    expect(fillVisible({ background: "linear-gradient(135deg, #f00, #00f)" }, true)).toBe(true);
  });
});

describe("edgeBands", () => {
  it.each([
    [{}, []],
    [{ border: "2px solid #111" }, [{ inner: -2, outer: 0 }]],
    [{ border: "solid red" }, [{ inner: -3, outer: 0 }]],
    [{ border: "2px #111" }, []],
    [{ border: "2px solid transparent" }, []],
    [{ border: "0px solid #111" }, []],
    [{ border: "2px solid" }, [{ inner: -2, outer: 0 }]],
    [{ border: "2px solid #111", "border-width": "6px" }, [{ inner: -6, outer: 0 }]],
    [{ "border-width": "2px", "border-style": "dashed", "border-color": "#111" }, [{ inner: -2, outer: 0 }]],
    [{ outline: "2px solid #111" }, [{ inner: 0, outer: 2 }]],
    [{ outline: "2px solid #111", "outline-offset": "-1px" }, [{ inner: -1, outer: 1 }]],
    [
      { border: "1px solid #000", outline: "3px solid #f00", "outline-offset": "2px" },
      [
        { inner: -1, outer: 0 },
        { inner: 2, outer: 5 },
      ],
    ],
    [{ "box-shadow": "0 2px 8px #000" }, []],
  ] as [StyleMap, { inner: number; outer: number }[]][])("edgeBands(%o)", (style, expected) => {
    expect(edgeBands(style)).toEqual(expected);
  });
});

describe("drawnStrokeWidth", () => {
  it.each([
    [{}, "path", 2],
    [{ fill: "#000" }, "path", null],
    [{ stroke: "#000" }, "path", 1],
    [{ stroke: "#000", "stroke-width": "3" }, "path", 3],
    [{ stroke: "none" }, "path", 2],
    [{ border: "2px solid #000" }, "polygon", 2],
    [{}, "polygon", null],
    [{ background: "#000" }, "polygon", null],
    [{ stroke: "rgba(0,0,0,0)" }, "polygon", null],
    // Blocker fix (§3.3): an authored-but-fully-transparent fill is "a fill
    // was authored" for `pathPaint`'s literal check, so no default-ink band —
    // this must stay `null` even though `fillVisible(style, true)` is `false`.
    [{ fill: "rgba(0,0,0,0)" }, "path", null],
    [{ fill: "none" }, "path", 2],
    [{ fill: "rgba(0,0,0,0)" }, "group", null],
  ] as [StyleMap, "polygon" | "ellipse" | "path" | "group", number | null][])(
    "drawnStrokeWidth(%o, %s) === %s",
    (style, kind, expected) => {
      expect(drawnStrokeWidth(style, kind)).toBe(expected);
    },
  );
});
