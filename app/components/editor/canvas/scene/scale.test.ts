import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { laidOutScene } from "./autoLayout";
import { applyOps, reflowHugs } from "./ops";
import { parseScene } from "./parse";
import { findNode, isGroup, type Rect, type Scene } from "./types";

const parse = (html: string): Scene =>
  reflowHugs(parseScene(html, (h) => parseHTML(h).document as unknown as Document));

const rectOf = (scene: Scene, id: string): Rect => {
  const node = findNode(scene, id)!;
  return { x: node.x, y: node.y, w: node.w, h: node.h };
};

/** Children of an auto-layout group, as laid out — the boxes the screen shows. */
const laidChildren = (scene: Scene, groupId: string) => {
  const laid = laidOutScene(scene);
  const group = findNode(laid, groupId)!;
  if (!isGroup(group)) throw new Error("not a group");
  return group.children.map((child) => ({ id: child.id, x: child.x, y: child.y, w: child.w, h: child.h }));
};

const HUGGING = `<nt-diagram w="800" h="600">
  <nt-group id="g" x="100" y="100" w="0" h="0" style="display: flex; gap: 8px; padding: 12px; width: fit-content; height: fit-content">
    <nt-rect id="a" x="0" y="0" w="100" h="50"></nt-rect>
    <nt-rect id="b" x="0" y="0" w="60" h="80"></nt-rect>
  </nt-group>
</nt-diagram>`;

describe("scaling an auto-layout group", () => {
  it("is the same picture at another size", () => {
    const scene = parse(HUGGING);
    expect(rectOf(scene, "g")).toEqual({ x: 100, y: 100, w: 192, h: 104 });
    expect(laidChildren(scene, "g")).toEqual([
      { id: "a", x: 12, y: 12, w: 100, h: 50 },
      { id: "b", x: 120, y: 12, w: 60, h: 80 },
    ]);

    const scaled = applyOps(scene, [{ type: "scale", ids: ["g"], k: 2, anchor: { x: 100, y: 100 } }]);
    expect(rectOf(scaled, "g")).toEqual({ x: 100, y: 100, w: 384, h: 208 });
    expect(findNode(scaled, "g")!.style.gap).toBe("16px");
    expect(findNode(scaled, "g")!.style.padding).toBe("24px");
    expect(laidChildren(scaled, "g")).toEqual([
      { id: "a", x: 24, y: 24, w: 200, h: 100 },
      { id: "b", x: 240, y: 24, w: 120, h: 160 },
    ]);
  });

  it("scales a fixed-size auto-layout group the same way", () => {
    const scene = parse(HUGGING.replace("width: fit-content; height: fit-content", "width: 300px; height: 120px").replace('w="0" h="0"', 'w="300" h="120"'));
    const scaled = applyOps(scene, [{ type: "scale", ids: ["g"], k: 0.5, anchor: { x: 100, y: 100 } }]);
    expect(rectOf(scaled, "g")).toEqual({ x: 100, y: 100, w: 150, h: 60 });
    expect(laidChildren(scaled, "g")).toEqual([
      { id: "a", x: 6, y: 6, w: 50, h: 25 },
      { id: "b", x: 60, y: 6, w: 30, h: 40 },
    ]);
  });

  it("scales a child inside the flow without moving it out of it", () => {
    const scene = parse(HUGGING);
    const scaled = applyOps(scene, [{ type: "scale", ids: ["a"], k: 2, anchor: { x: 112, y: 112 } }]);
    expect(laidChildren(scaled, "g")).toEqual([
      { id: "a", x: 12, y: 12, w: 200, h: 100 },
      { id: "b", x: 220, y: 12, w: 60, h: 80 },
    ]);
    // The hug follows the child it holds.
    expect(rectOf(scaled, "g").w).toBe(12 + 200 + 8 + 60 + 12);
  });
});
