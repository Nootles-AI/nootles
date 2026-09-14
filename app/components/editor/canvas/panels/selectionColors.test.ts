import { describe, expect, it } from "vitest";
import { collectSelectionColors, recolorOps } from "./selectionColors";
import type { NodeId, RectNode, Scene, StyleMap } from "../scene/types";

const rect = (id: NodeId, style: StyleMap = {}, label = ""): RectNode => ({
  id,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rot: 0,
  style,
  label,
  locked: false,
  hidden: false,
  attrs: {},
  kind: "rect",
});

const scene = (nodes: Scene["nodes"], style: StyleMap = {}): Scene => ({
  w: 100,
  h: 100,
  style,
  nodes,
  edges: [],
  attrs: {},
});

describe("collectSelectionColors", () => {
  it("collects distinct colours across a subtree, in document order", () => {
    const nodes = [rect("a", { background: "#123456" }), rect("b", { border: "1px solid #111111" })];
    const colors = collectSelectionColors(scene(nodes), nodes);
    expect(colors.map((c) => c.authored)).toEqual(["#123456", "#111111"]);
  });

  it("#FFF and #ffffff are one entry (same canonical key)", () => {
    const nodes = [rect("a", { background: "#FFF" }), rect("b", { background: "#ffffff" })];
    const colors = collectSelectionColors(scene(nodes), nodes);
    expect(colors).toHaveLength(1);
    expect(colors[0].uses).toBe(2);
    // First authored spelling wins, document order.
    expect(colors[0].authored).toBe("#FFF");
  });

  it("var(--brand) is its own entry even when it resolves to a literal already present", () => {
    const nodes = [rect("a", { background: "#6366f1" }), rect("b", { background: "var(--brand)" })];
    const colors = collectSelectionColors(scene(nodes, { "--brand": "#6366f1" }), nodes);
    expect(colors).toHaveLength(2);
    expect(colors.find((c) => c.bound === "--brand")).toBeTruthy();
  });

  it("counts a gradient's stops individually", () => {
    const nodes = [rect("a", { background: "linear-gradient(90deg, #000 0%, #000 50%, #fff 100%)" })];
    const colors = collectSelectionColors(scene(nodes), nodes);
    const black = colors.find((c) => c.authored === "#000");
    expect(black?.uses).toBe(2);
  });

  it("includes a label run's own colour spans", () => {
    const nodes = [rect("a", {}, '<p><span style="color: #ff00ff">hi</span></p>')];
    const colors = collectSelectionColors(scene(nodes), nodes);
    expect(colors.some((c) => c.authored === "#ff00ff")).toBe(true);
  });

  it("excludes a hidden --nt-off-* effect marker (never one of the scanned properties)", () => {
    const nodes = [rect("a", { "--nt-off-box-shadow": "0 0 0 4px #ff0000", background: "#fff" })];
    const colors = collectSelectionColors(scene(nodes), nodes);
    expect(colors.map((c) => c.authored)).toEqual(["#fff"]);
  });

  it("walks descendants of the selected nodes too", () => {
    const child = rect("child", { background: "#abcdef" });
    const parent = { ...rect("parent", {}), kind: "group" as const, children: [child] };
    const colors = collectSelectionColors(scene([parent]), [parent]);
    expect(colors.map((c) => c.authored)).toEqual(["#abcdef"]);
  });
});

describe("recolorOps", () => {
  it("writes one setStyle per node with only the changed properties", () => {
    const nodes = [
      rect("a", { background: "#123456", border: "1px solid #123456" }),
      rect("b", { background: "#123456" }),
    ];
    const key = collectSelectionColors(scene(nodes), nodes)[0].key;
    const ops = recolorOps(scene(nodes), nodes, key, "#000000");
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      type: "setStyle",
      ids: ["a"],
      decls: { background: "#000000", border: "1px solid #000000" },
    });
    expect(ops[1]).toEqual({ type: "setStyle", ids: ["b"], decls: { background: "#000000" } });
  });

  it("writes setLabel only when a run's colour actually changed", () => {
    const nodes = [rect("a", { background: "#123456" }, '<p><span style="color: #123456">hi</span></p>')];
    const key = collectSelectionColors(scene(nodes), nodes)[0].key;
    const ops = recolorOps(scene(nodes), nodes, key, "#000000");
    expect(ops.some((op) => op.type === "setLabel")).toBe(true);
    const setLabel = ops.find((op) => op.type === "setLabel");
    expect(setLabel).toMatchObject({ id: "a" });
  });

  it("recolor-preserves-bytes: untouched declarations are identical", () => {
    const nodes = [rect("a", { background: "#123456", color: "#ff00ff" })];
    const key = collectSelectionColors(scene(nodes), nodes)[0].key; // #123456
    const ops = recolorOps(scene(nodes), nodes, key, "#000000");
    expect(ops).toEqual([{ type: "setStyle", ids: ["a"], decls: { background: "#000000" } }]);
  });

  it("is empty for a key not present in the subtree", () => {
    const nodes = [rect("a", { background: "#123456" })];
    expect(recolorOps(scene(nodes), nodes, "#ffffff", "#000000")).toEqual([]);
  });

  it("recolours only the matching var() reference, not a coincidentally-equal literal", () => {
    const nodes = [rect("a", { background: "var(--brand)" }), rect("b", { background: "#6366f1" })];
    const colors = collectSelectionColors(scene(nodes, { "--brand": "#6366f1" }), nodes);
    const varKey = colors.find((c) => c.bound === "--brand")!.key;
    const ops = recolorOps(scene(nodes), nodes, varKey, "var(--accent)");
    expect(ops).toEqual([{ type: "setStyle", ids: ["a"], decls: { background: "var(--accent)" } }]);
  });
});
