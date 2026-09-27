import { DOMParser } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { BAND, bandHeight } from "../scene/band";
import { readCanvasSource } from "../scene/migrate";
import { applyOps } from "../scene/ops";
import { findNode } from "../scene/types";
import { deleteDiagramBlock, mergeOps, type LifecycleEditor } from "./lifecycle";

(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const upper = readCanvasSource(
  `<nt-diagram h="160" style="background: #fafafa">` +
    `<nt-rect id="a" x="40" y="24" w="100" h="60"></nt-rect>` +
    `<nt-rect id="b" x="300" y="24" w="100" h="60"></nt-rect>` +
    `<nt-edge id="e1" from="a" to="b"></nt-edge></nt-diagram>`,
);
const lower = readCanvasSource(
  `<nt-diagram h="120" style="background: #000">` +
    `<nt-rect id="a" x="80" y="24" w="100" h="60"></nt-rect>` +
    `<nt-group id="g" x="400" y="30" w="120" h="60"><nt-rect id="b" x="0" y="0" w="50" h="50"></nt-rect></nt-group>` +
    `<nt-edge id="e1" from="a" to="b"></nt-edge></nt-diagram>`,
);

describe("merging the diagram below into the one above", () => {
  const merged = applyOps(upper, mergeOps(upper, lower));
  const dy = bandHeight(upper);

  it("puts its shapes under this band, as far down as this band is tall", () => {
    expect(merged.nodes).toHaveLength(4);
    const [, , first, group] = merged.nodes;
    expect({ x: first.x, y: first.y }).toEqual({ x: 80, y: 24 + dy });
    expect({ x: group.x, y: group.y }).toEqual({ x: 400, y: 30 + dy });
  });

  it("gives every copied shape, children included, an id of its own here", () => {
    const ids: string[] = [];
    const visit = (nodes: typeof merged.nodes) =>
      nodes.forEach((node) => {
        ids.push(node.id);
        if ("children" in node) visit(node.children);
      });
    visit(merged.nodes);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findNode(merged, "a")).toMatchObject({ x: 40, y: 24 });
  });

  it("keeps its connectors on its own shapes, under ids of their own", () => {
    expect(merged.edges).toHaveLength(2);
    const [, moved] = merged.edges;
    expect(moved.id).not.toBe("e1");
    const [, , first, group] = merged.nodes;
    const child = "children" in group ? group.children[0] : null;
    expect({ from: moved.from, to: moved.to }).toEqual({ from: first.id, to: child?.id });
  });

  it("is as tall as the two were, keeps its own ground, and is wide if either was", () => {
    expect(merged.h).toBe(dy + bandHeight(lower));
    expect(merged.style.background).toBe("#fafafa");
    expect(merged.wide).toBeUndefined();
    const wideBelow = { ...lower, wide: true as const };
    expect(applyOps(upper, mergeOps(upper, wideBelow)).wide).toBe(true);
    const wideAbove = { ...upper, wide: true as const };
    expect(applyOps(wideAbove, mergeOps(wideAbove, lower)).wide).toBe(true);
  });

  it("of an empty diagram below, only makes room for it", () => {
    const empty = readCanvasSource(`<nt-diagram h="${2 * BAND + 26}"></nt-diagram>`);
    const ops = mergeOps(upper, empty);
    expect(ops).toEqual([{ type: "setDiagram", h: dy + bandHeight(empty) }]);
  });
});

describe("a diagram's block taken out of the page", () => {
  const editor = (prev?: string, next?: string) => {
    const calls: string[] = [];
    const host: LifecycleEditor = {
      transact: (fn) => {
        calls.push("transact{");
        const out = fn();
        calls.push("}");
        return out;
      },
      removeBlocks: (ids) => calls.push(`remove ${ids.join()}`),
      getPrevBlock: () => (prev ? { id: prev } : undefined),
      getNextBlock: () => (next ? { id: next } : undefined),
      setTextCursorPosition: (id, at) => void calls.push(`caret ${id} ${at}`),
      focus: vi.fn(() => void calls.push("focus")),
    };
    return { host, calls };
  };

  it("goes in one transaction, the caret at the end of the block before it", () => {
    const { host, calls } = editor("p1", "p2");
    deleteDiagramBlock(host, "d");
    expect(calls).toEqual(["transact{", "remove d", "caret p1 end", "}", "focus"]);
  });

  it("or at the start of the one after, when it was first", () => {
    const { host, calls } = editor(undefined, "p2");
    deleteDiagramBlock(host, "d");
    expect(calls).toEqual(["transact{", "remove d", "caret p2 start", "}", "focus"]);
  });
});
