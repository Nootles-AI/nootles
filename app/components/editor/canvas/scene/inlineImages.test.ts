import { describe, expect, it } from "vitest";
import { hoistOps, inlinePictures } from "./inlineImages";
import { applyOps } from "./ops";
import type { Scene, SceneNode } from "./types";

const base = { x: 0, y: 0, w: 10, h: 10, rot: 0, label: "", locked: false, hidden: false, attrs: {} };
const A = "data:image/png;base64,AAAA";
const B = "data:image/jpeg;base64,BBBB";

const nodes: SceneNode[] = [
  { ...base, id: "i1", kind: "image", src: A, style: {} },
  { ...base, id: "i2", kind: "image", src: "https://files.example/x.png", style: {} },
  {
    ...base,
    id: "g1",
    kind: "group",
    style: {},
    children: [
      { ...base, id: "r1", kind: "rect", style: { background: `url("${B}") center / cover`, color: "#fff" } },
      { ...base, id: "r2", kind: "rect", style: { background: "#fff" } },
    ],
  },
];
const scene: Scene = { w: 100, h: 100, style: {}, attrs: {}, edges: [], nodes };

describe("inline pictures", () => {
  it("finds an image src and a fill, at any depth, never a URL", () => {
    expect(inlinePictures(nodes)).toEqual([A, B]);
  });

  it("writes one op per changed shape, and the ops re-address only the pictures", () => {
    const urls = new Map([[A, "https://files.example/a.png"], [B, "https://files.example/b.jpg"]]);
    const ops = hoistOps(nodes, urls);
    expect(ops).toEqual([
      { type: "setSrc", id: "i1", src: "https://files.example/a.png" },
      { type: "setStyle", ids: ["r1"], decls: { background: 'url("https://files.example/b.jpg") center / cover' } },
    ]);
    const next = applyOps(scene, ops);
    expect(next.nodes[1]).toBe(nodes[1]);
    expect(inlinePictures(next.nodes)).toEqual([]);
    const group = next.nodes[2];
    if (group.kind !== "group") throw new Error("group");
    expect(group.children[0].style).toEqual({
      background: 'url("https://files.example/b.jpg") center / cover',
      color: "#fff",
    });
    expect(group.children[1]).toBe((nodes[2] as { children: SceneNode[] }).children[1]);
  });

  it("leaves a picture inline when it has no URL", () => {
    const ops = hoistOps(nodes, new Map([[A, "https://files.example/a.png"]]));
    expect(ops).toEqual([{ type: "setSrc", id: "i1", src: "https://files.example/a.png" }]);
  });
});
