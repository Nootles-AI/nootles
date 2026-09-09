import { describe, expect, it } from "vitest";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { findNode, type GroupNode } from "@/app/components/editor/canvas/scene/types";
import { convertSelection } from "./convert";
import type { FigNode, Transform } from "./model";
import { misplaced } from "./oracle";

const solid = (r: number, g: number, b: number) => ({ type: "SOLID", color: { r, g, b }, opacity: 1 });
const turned90 = (x: number, y: number): Transform => [
  [0, 1, x],
  [-1, 0, y],
];

// Reduced from a details dump: a subtract whose operands are a rounded rect
// and a turned group holding a rect and another subtract of an ellipse and a
// vector. Ids and names are the file's own.
describe("a Figma boolean", () => {
  it("becomes a boolean group holding its operands, nested and turned alike", async () => {
    const subtract: FigNode = {
      id: "28:2", name: "Subtract", type: "BOOLEAN_OPERATION", booleanOperation: "SUBTRACT",
      x: 18.2383, y: 16.3788, width: 35.8603, height: 35.915,
      absoluteTransform: [[1, 0, -35.7617], [0, 1, -136.6212]], relativeTransform: [[1, 0, 18.2383], [0, 1, 16.3788]],
      fills: [solid(0.7804, 0.1882, 0.1882)],
      children: [
        {
          id: "28:3", name: "Rectangle 4", type: "RECTANGLE", x: 18.1832, y: 16.3789, width: 35.9153, height: 35.9148,
          absoluteTransform: [[1, 0, -35.8168], [0, 1, -136.6211]], relativeTransform: [[1, 0, 18.1832], [0, 1, 16.3789]],
          fills: [solid(0.7804, 0.1882, 0.1882)], cornerRadius: 17.9574,
        },
        {
          id: "28:4", name: "Group 8", type: "GROUP", x: 18.1832, y: 43.4668, width: 17.7215, height: 28.3394, rotation: 90,
          absoluteTransform: turned90(-35.8168, -109.5332), relativeTransform: turned90(18.1832, 43.4668),
          children: [
            {
              id: "28:5", name: "Rectangle 3", type: "RECTANGLE", x: 18.1832, y: 36.2902, width: 3.3682, height: 9.2642, rotation: 90,
              absoluteTransform: turned90(-35.8168, -116.7098), relativeTransform: turned90(18.1832, 36.2902), fills: [solid(1, 1, 1)],
            },
            {
              id: "28:6", name: "Subtract", type: "BOOLEAN_OPERATION", booleanOperation: "SUBTRACT",
              x: 26.3524, y: 39.2926, width: 9.373, height: 1.6592, rotation: 90,
              absoluteTransform: turned90(-27.6476, -113.7074), relativeTransform: turned90(26.3524, 39.2926), fills: [solid(1, 1, 1)],
              children: [
                {
                  id: "28:7", name: "Ellipse 1", type: "ELLIPSE", x: 26.3523, y: 40.865, width: 12.5179, height: 9.8285, rotation: 90,
                  absoluteTransform: turned90(-27.6477, -112.135), relativeTransform: turned90(26.3523, 40.865),
                  fills: [solid(0.851, 0.851, 0.851)], arcData: { startingAngle: 0, endingAngle: 6.2832, innerRadius: 0 },
                },
                {
                  id: "28:8", name: "Rectangle 4", type: "VECTOR", x: 28.0117, y: 41.608, width: 14.3625, height: 16.3382, rotation: 90,
                  absoluteTransform: turned90(-25.9884, -111.392), relativeTransform: turned90(28.0117, 41.608),
                  fills: [solid(0.851, 0.851, 0.851)], vectorPaths: [{ windingRule: "NONZERO", data: "M 0 0 L 14.3625 0 L 14.3625 16.3382 L 0 16.3382 Z" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const { scene, report, count } = await convertSelection([subtract], async () => null);
    expect(report).toEqual([]);
    expect(count).toBe(7);

    const outer = findNode(scene, "f28-2") as GroupNode;
    expect(outer.op).toBe("subtract");
    expect(outer.style).toEqual({ fill: "#c73030", stroke: "none" });
    expect(outer.children.map((c) => c.id)).toEqual(["f28-3", "f28-4"]);
    expect(findNode(scene, "f28-3")).toMatchObject({ kind: "rect", style: { "border-radius": "17.96px" } });
    expect(findNode(scene, "f28-4")).toMatchObject({ kind: "group", rot: 270 });
    expect((findNode(scene, "f28-4") as GroupNode).op).toBeUndefined();
    expect(findNode(scene, "f28-6")).toMatchObject({ kind: "group", op: "subtract", rot: 0 });
    expect(findNode(scene, "f28-7")).toMatchObject({ kind: "ellipse" });
    expect(findNode(scene, "f28-8")).toMatchObject({ kind: "path" });
    expect(misplaced([subtract], scene)).toEqual([]);

    const html = serializeScene(scene);
    expect(html).toContain('<nt-group id="f28-2" x="0" y="0" w="35.86" h="35.92" op="subtract" data-figma-id="28:2" style="fill: #c73030; stroke: none">');
  });

  it("falls back to the geometry Figma computed when the operands are gone", async () => {
    const flat: FigNode = {
      id: "30:1", name: "Union", type: "BOOLEAN_OPERATION", booleanOperation: "UNION", x: 0, y: 0, width: 20, height: 20,
      absoluteTransform: [[1, 0, 0], [0, 1, 0]], fills: [solid(0, 0, 0)], fillGeometry: [{ data: "M 0 0 L 20 0 L 20 20 Z" }],
    };
    const { scene } = await convertSelection([flat], async () => null);
    expect(findNode(scene, "f30-1")).toMatchObject({ kind: "path", d: "M 0 0 L 20 0 L 20 20 Z" });
  });
});
