import { describe, expect, it } from "vitest";
import { canonicalPath, canonicalPathOps } from "./canonicalPaths";
import { applyOps } from "./ops";
import type { Scene, SceneNode } from "./types";

const base = { x: 0, y: 0, w: 10, h: 10, rot: 0, label: "", locked: false, hidden: false, attrs: {}, style: {} };
const FIGMA = "M 10.265440940856934 8.263401985168457 C 10.526340901851654 8.524380773305893 10.672906875610352 8.878297120332718 10.672906875610352 9.247321128845215 L 2.3927013874053955 18.103981018066406 Z";

describe("canonical paths", () => {
  it("writes a Figma-precision path the way the pen tool would", () => {
    expect(canonicalPath(FIGMA)).toBe("M 10.265 8.263 C 10.526 8.524 10.673 8.878 10.673 9.247 L 2.393 18.104 Z");
  });

  it("is idempotent, and leaves a path it cannot shrink or parse alone", () => {
    const once = canonicalPath(FIGMA);
    expect(canonicalPath(once)).toBe(once);
    expect(canonicalPath("M 0 0 L 1 1")).toBe("M 0 0 L 1 1");
    expect(canonicalPath("not a path")).toBe("not a path");
  });

  it("emits one setPath per path that shrinks, at any depth, and remembers what it saw", () => {
    const nodes: SceneNode[] = [
      { ...base, id: "p1", kind: "path", d: FIGMA },
      { ...base, id: "g", kind: "group", children: [{ ...base, id: "p2", kind: "path", d: "M 0 0 L 1 1" }] },
    ];
    const seen = new Set<string>();
    const ops = canonicalPathOps(nodes, seen);
    expect(ops).toEqual([{ type: "setPath", id: "p1", d: canonicalPath(FIGMA) }]);
    const scene: Scene = { w: 10, h: 10, style: {}, attrs: {}, edges: [], nodes };
    const next = applyOps(scene, ops);
    expect(canonicalPathOps(next.nodes, seen)).toEqual([]);
    // Seen from a fresh set too: the canonical form is its own fixed point.
    expect(canonicalPathOps(next.nodes, new Set())).toEqual([]);
    // A raw path that comes back — a scene re-adopted from the document — is
    // rewritten again; only canonical forms are remembered.
    expect(canonicalPathOps(nodes, seen)).toEqual(ops);
  });
});
