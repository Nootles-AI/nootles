import { describe, expect, it } from "vitest";
import { findNode, type GroupNode } from "@/app/components/editor/canvas/scene/types";
import { convertSelection } from "./convert";
import type { FigNode, Transform } from "./model";
import { misplaced } from "./oracle";

const solid = { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 };
const at = (x: number, y: number): Transform => [
  [1, 0, x],
  [0, 1, y],
];
/** Flipped left to right, then turned `deg` counter-clockwise, at (x, y). */
const flipped = (deg: number, x: number, y: number): Transform => {
  const r = (deg * Math.PI) / 180;
  return [
    [-Math.cos(r), Math.sin(r), x],
    [Math.sin(r), Math.cos(r), y],
  ];
};
const mul = (o: Transform, i: Transform): Transform => [
  [o[0][0] * i[0][0] + o[0][1] * i[1][0], o[0][0] * i[0][1] + o[0][1] * i[1][1], o[0][0] * i[0][2] + o[0][1] * i[1][2] + o[0][2]],
  [o[1][0] * i[0][0] + o[1][1] * i[1][0], o[1][0] * i[0][1] + o[1][1] * i[1][1], o[1][0] * i[0][2] + o[1][1] * i[1][2] + o[1][2]],
];

// The shape of the report: a subtract whose operands all sit inside a group
// that was flipped in Figma.
describe("a flipped layer", () => {
  const operands = (group: Transform): FigNode[] => [
    { id: "1:3", name: "Rectangle 3", type: "RECTANGLE", x: 0, y: 0, width: 40, height: 20, topLeftRadius: 6, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0, absoluteTransform: mul(group, at(0, 0)), fills: [solid] },
    { id: "1:4", name: "Ellipse 1", type: "ELLIPSE", x: 0, y: 0, width: 20, height: 20, absoluteTransform: mul(group, at(10, 0)), fills: [solid], arcData: { startingAngle: -Math.PI / 2, endingAngle: 0, innerRadius: 0 } },
    { id: "1:5", name: "Vector", type: "VECTOR", x: 0, y: 0, width: 10, height: 10, absoluteTransform: mul(group, at(30, 10)), fills: [solid], vectorPaths: [{ windingRule: "NONZERO", data: "M 0 0 L 10 0 L 0 10 Z" }] },
    { id: "1:6", name: "Label", type: "TEXT", x: 0, y: 0, width: 30, height: 10, absoluteTransform: mul(group, at(0, 20)), characters: "hi", fontSize: 10, fontName: { family: "Inter", style: "Regular" }, fills: [solid] },
  ];
  const subtract = (group: Transform): FigNode => ({
    id: "1:2",
    name: "Subtract",
    type: "BOOLEAN_OPERATION",
    booleanOperation: "SUBTRACT",
    x: 0,
    y: 0,
    width: 40,
    height: 30,
    absoluteTransform: group,
    fills: [solid],
    children: operands(group),
  });

  it("is drawn flipped, geometry and all, and says so only for words", async () => {
    const selection = subtract(flipped(0, 140, 100));
    const { scene, report } = await convertSelection([selection], noImages);
    expect(report.map((r) => `${r.code} ${r.nodeId}`)).toEqual(["flipped 1:6"]);
    expect(misplaced([selection], scene)).toEqual([]);

    // The group itself is square: the flip is in its children's geometry.
    expect(findNode(scene, "f1-2")).toMatchObject({ rot: 0, op: "subtract" });
    // A corner on the left is now on the right.
    expect(findNode(scene, "f1-3")!.style["border-radius"]).toBe("0px 6px 0px 0px");
    // The quarter from twelve to three o'clock is now the one from nine to twelve.
    expect(findNode(scene, "f1-4")).toMatchObject({ start: 270, sweep: 90 });
    // The triangle's right angle moves from the left edge to the right.
    expect(findNode(scene, "f1-5")).toMatchObject({ d: "M 10 0 L 0 0 L 10 10 Z", x: 0, y: 10 });
    expect(findNode(scene, "f1-6")).toMatchObject({ kind: "text", label: "hi" });
  });

  it("keeps the turn that follows the flip", async () => {
    const selection = subtract(flipped(90, 140, 100));
    const { scene, report } = await convertSelection([selection], noImages);
    expect(report.map((r) => r.code)).toEqual(["flipped"]);
    expect(misplaced([selection], scene)).toEqual([]);
    expect((findNode(scene, "f1-2") as GroupNode).rot).toBe(270);
    expect(findNode(scene, "f1-5")).toMatchObject({ d: "M 10 0 L 0 0 L 10 10 Z", rot: 0 });
  });
});

const noImages = async () => null;
