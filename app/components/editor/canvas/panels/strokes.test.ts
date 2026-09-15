import { describe, expect, it } from "vitest";
import { readStroke, shorthandOf, writeStroke, type Stroke } from "./strokes";
import type { NodeId, PathNode, RectNode, StyleMap } from "../scene/types";

const rect = (id: NodeId, style: StyleMap = {}): RectNode => ({
  id,
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

const pathNode = (id: NodeId, style: StyleMap = {}): PathNode => ({
  ...rect(id, style),
  kind: "path",
  d: "M 0 0 L 10 10",
});

describe("readStroke", () => {
  it("reads a border shorthand", () => {
    expect(readStroke(rect("a", { border: "3px dashed #111" }))).toEqual({
      color: "#111",
      width: 3,
      dash: "dashed",
      position: "inside",
    });
  });

  it("reads an outline with a negative offset as center", () => {
    expect(readStroke(rect("a", { outline: "2px solid #222", "outline-offset": "-1px" }))).toEqual({
      color: "#222",
      width: 2,
      dash: "solid",
      position: "center",
    });
  });

  it("reads a plain (non-negative) outline as outside", () => {
    expect(readStroke(rect("a", { outline: "2px solid #222" }))?.position).toBe("outside");
  });

  it("reads longhands when no shorthand is set", () => {
    expect(readStroke(rect("a", { "border-width": "4px", "border-style": "dotted", "border-color": "#333" }))).toEqual({
      color: "#333",
      width: 4,
      dash: "dotted",
      position: "inside",
    });
  });

  it("returns null with no stroke authored", () => {
    expect(readStroke(rect("a", {}))).toBeNull();
  });

  it("reads a path's stroke/stroke-width/stroke-dasharray, always centred", () => {
    expect(readStroke(pathNode("p", { stroke: "#00f", "stroke-width": "6", "stroke-dasharray": "8 6" }))).toEqual({
      color: "#00f",
      width: 6,
      dash: "dashed",
      position: "center",
    });
  });

  it("a zero-width border is still a stroke (keeps its colour)", () => {
    expect(readStroke(rect("a", { border: "0px solid #444" }))).toMatchObject({ color: "#444", width: 0 });
  });
});

describe("writeStroke", () => {
  const stroke: Stroke = { color: "#111", width: 2, dash: "solid", position: "inside" };

  it("inside writes border", () => {
    const style = writeStroke(rect("a"), stroke);
    expect(style.border).toBe("2px solid #111");
    expect(style.outline).toBeUndefined();
  });

  it("outside writes outline", () => {
    const style = writeStroke(rect("a"), { ...stroke, position: "outside" });
    expect(style.outline).toBe("2px solid #111");
    expect(style["outline-offset"]).toBeUndefined();
  });

  it("center writes outline + a negative outline-offset", () => {
    const style = writeStroke(rect("a"), { ...stroke, position: "center" });
    expect(style.outline).toBe("2px solid #111");
    expect(style["outline-offset"]).toBe("-1px");
  });

  it("writing null clears every box stroke property", () => {
    const style = writeStroke(rect("a", { border: "1px solid #000", "outline-offset": "-2px" }), null);
    expect(style.border).toBeUndefined();
    expect(style["outline-offset"]).toBeUndefined();
  });

  it("a path stroke never sets an alignment property", () => {
    const style = writeStroke(pathNode("p"), stroke);
    expect(style.stroke).toBe("#111");
    expect(style["stroke-width"]).toBe("2");
    expect(style.border).toBeUndefined();
  });
});

describe("shorthandOf", () => {
  it("falls back to longhands when no shorthand is authored", () => {
    expect(shorthandOf({ "border-width": "1px", "border-style": "solid", "border-color": "#000" }, "border")).toBe(
      "1px solid #000",
    );
  });

  it("prefers the shorthand when both are present", () => {
    expect(shorthandOf({ border: "2px dashed #fff", "border-width": "9px" }, "border")).toBe("2px dashed #fff");
  });
});
