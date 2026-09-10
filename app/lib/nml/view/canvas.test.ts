import { parseHTML } from "linkedom";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { applyOps } from "@/app/components/editor/canvas/scene/ops";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import type {
  Scene,
  SceneEdge,
  SceneNode,
  SceneOp,
} from "@/app/components/editor/canvas/scene/types";
import {
  createNmlYDoc,
  decodeNmlDocument,
  executeNmlCommands,
  type NmlDocument,
} from "..";
import { EditableNmlBridge } from "./bridge";
import {
  canvasTextDiff,
  compileCanvasSceneChange,
  deriveCanvasMirror,
} from "./canvas";

const base = {
  y: 20,
  w: 100,
  h: 60,
  rot: 0,
  style: { background: "#fff" },
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
};

function rect(id: string, x: number, label = id): SceneNode {
  return { ...base, id, kind: "rect", x, label };
}

function edge(id: string, from: string, to: string): SceneEdge {
  return { id, from, to, label: id, style: { stroke: "#111" }, attrs: {} };
}

function scene(): Scene {
  return {
    id: "canvas",
    w: 960,
    h: 540,
    style: { background: "#fafafa" },
    attrs: { "data-mode": "test" },
    nodes: [
      rect("r1", 10, "Alpha 👩🏽‍💻"),
      { ...base, id: "ellipse", kind: "ellipse", x: 140, label: "Round" },
      { ...base, id: "polygon", kind: "polygon", x: 270, sides: 4, label: "Four" },
      { ...base, id: "text", kind: "text", x: 400, label: "Words" },
      { ...base, id: "image", kind: "image", x: 530, src: "/one.png" },
      { ...base, id: "path", kind: "path", x: 660, d: "M0 0L100 60" },
      {
        ...base,
        id: "group",
        kind: "group",
        x: 40,
        y: 140,
        w: 320,
        h: 160,
        children: [rect("child-a", 10), rect("child-b", 140)],
      },
    ],
    edges: [edge("edge-a", "r1", "ellipse"), edge("edge-b", "ellipse", "polygon")],
  };
}

function document(value = scene()): NmlDocument {
  return {
    schemaVersion: 1,
    documentId: "canvas-document",
    blocks: [{ id: "canvas", type: "canvas", props: {}, scene: value, children: [] }],
  };
}

function decodedScene(doc: Y.Doc): Scene {
  const block = decodeNmlDocument(doc).blocks[0];
  if (block.type !== "canvas") throw new Error("Expected canvas block");
  return block.scene;
}

let transaction = 0;
async function execute(doc: Y.Doc, commands: ReturnType<typeof compileCanvasSceneChange>["commands"]) {
  const id = `canvas-${++transaction}`;
  return executeNmlCommands({
    doc,
    documentId: "canvas-document",
    commands,
    origin: {
      version: 1,
      transactionId: id,
      actor: { userId: "canvas-test", kind: "human" },
      command: "canvas-gesture",
    },
    idempotencyKey: id,
    authorize: () => true,
  });
}

async function applyCompiled(doc: Y.Doc, before: Scene, after: Scene) {
  const compiled = compileCanvasSceneChange("canvas", before, after);
  expect(compiled.commands.every((command) => command.type !== "replaceDomain")).toBe(true);
  await execute(doc, compiled.commands);
  expect(decodedScene(doc)).toEqual(after);
  return compiled;
}

describe("canonical NML canvas commands", () => {
  it("updates every root, shape-kind, label, and edge field with AST/Yjs/HTML parity", async () => {
    const before = scene();
    const after = structuredClone(before);
    Object.assign(after, {
      w: 1200,
      h: 720,
      style: { background: "#000", color: "#fff" },
      attrs: { role: "img" },
    });
    Object.assign(after.nodes[0], {
      x: 33,
      y: 44,
      w: 180,
      h: 90,
      rot: 15,
      style: { background: "#f00", "border-radius": "8px" },
      label: "Alpha brave 👩🏽‍💻",
      name: "Primary",
      locked: true,
      hidden: true,
      attrs: { "data-shape": "hero" },
    });
    Object.assign(after.nodes[1], { start: 20, sweep: 180, inner: 0.25 });
    Object.assign(after.nodes[2], { sides: 7 });
    Object.assign(after.nodes[4], { src: "/two.png" });
    Object.assign(after.nodes[5], { d: "M0 60L100 0" });
    Object.assign(after.nodes[6], { op: "union" });
    Object.assign(after.edges[0], {
      to: "text",
      label: "edge expanded",
      style: { stroke: "#f0f", "stroke-width": "3" },
      attrs: { "data-route": "manual" },
    });

    const doc = createNmlYDoc(document(before));
    const compiled = await applyCompiled(doc, before, after);
    expect(compiled.commands).toContainEqual(expect.objectContaining({ type: "updateCanvas" }));
    expect(compiled.commands).toContainEqual(expect.objectContaining({ type: "replaceShapeLabel" }));
    expect(compiled.commands).toContainEqual(expect.objectContaining({ type: "replaceEdgeLabel" }));
    expect(compiled.commands).not.toContainEqual(expect.objectContaining({
      type: "updateShapes",
      patches: expect.arrayContaining([expect.objectContaining({ patch: expect.objectContaining({ label: expect.anything() }) })]),
    }));

    const mirror = deriveCanvasMirror(decodedScene(doc));
    expect(parseScene(mirror, (html) => parseHTML(html).document as unknown as Document)).toEqual(after);
    expect(deriveCanvasMirror(parseScene(mirror, (html) => parseHTML(html).document as unknown as Document))).toBe(mirror);
  });

  it("routes the complete canvas operation vocabulary through canonical commands", async () => {
    const start = scene();
    const doc = createNmlYDoc(document(start));
    const operations: SceneOp[][] = [
      [{ type: "move", ids: ["r1"], dx: 11, dy: 7 }],
      [{ type: "resize", frames: [{ id: "ellipse", x: 150, y: 25, w: 130, h: 85 }] }],
      [{ type: "scale", ids: ["polygon"], k: 1.25, anchor: { x: 270, y: 20 } }],
      [{ type: "rotate", ids: ["text"], rot: 37 }],
      [{ type: "setStyle", ids: ["r1"], decls: { color: "#123", background: undefined } }],
      [{ type: "setShape", ids: ["ellipse"], params: { start: 10, sweep: 220, inner: 0.3 } }],
      [{ type: "setLabel", id: "r1", label: "Edited label" }],
      [{ type: "setSrc", id: "image", src: "/changed.png" }],
      [{ type: "setName", id: "r1", name: "Named" }],
      [{ type: "setLocked", ids: ["r1"], locked: true }],
      [{ type: "setHidden", ids: ["r1"], hidden: true }],
      [{ type: "setPath", id: "path", d: "M0 0L80 40", frame: { x: 680, y: 30, w: 80, h: 40 } }],
      [{ type: "insert", nodes: [rect("inserted", 800)], index: 1 }],
      [{ type: "reorder", ids: ["inserted"], to: { at: "front" } }],
      [{ type: "group", ids: ["ellipse", "polygon"], groupId: "new-group", name: "Pair" }],
      [{ type: "ungroup", ids: ["new-group"] }],
      [{ type: "align", ids: ["ellipse", "polygon"], to: "top" }],
      [{ type: "distribute", ids: ["r1", "ellipse", "polygon"], axis: "horizontal", spacing: 24 }],
      [{ type: "addEdge", edges: [edge("edge-new", "r1", "text")] }],
      [{ type: "setEdgeLabel", id: "edge-new", label: "Connected" }],
      [{ type: "setEdgeStyle", ids: ["edge-new"], decls: { stroke: "#0af" } }],
      [{ type: "reconnect", id: "edge-new", from: "ellipse", to: "path" }],
      [{ type: "removeEdge", ids: ["edge-new"] }],
      [{ type: "setDiagram", w: 1100, h: 640, style: { background: "#eee" }, attrs: { "data-mode": undefined, title: "Diagram" } }],
      [{ type: "remove", ids: ["inserted"] }],
    ];

    let current = start;
    for (const ops of operations) {
      const next = applyOps(current, ops);
      expect(next).not.toBe(current);
      await applyCompiled(doc, current, next);
      current = next;
    }
  });

  it("preserves exact shape hierarchy and edge order across mixed insert, reparent, reorder, and removal", async () => {
    const before = scene();
    const after = structuredClone(before);
    const first = after.nodes.shift()!;
    const oldGroupIndex = after.nodes.findIndex((node) => node.id === "group");
    const [oldGroup] = after.nodes.splice(oldGroupIndex, 1);
    if (oldGroup?.kind !== "group") throw new Error("Expected group");
    const lifted = oldGroup.children.shift()!;
    after.nodes.splice(2, 0, {
      ...base,
      id: "outer",
      kind: "group",
      x: 25,
      y: 320,
      w: 500,
      h: 180,
      children: [first, rect("fresh", 200), oldGroup],
    });
    after.nodes.push(lifted);
    after.edges = [
      edge("edge-new", "fresh", "child-b"),
      after.edges[1],
      after.edges[0],
    ];
    const doc = createNmlYDoc(document(before));
    const compiled = await applyCompiled(doc, before, after);
    expect(compiled.commands.map((command) => command.type)).toEqual(expect.arrayContaining([
      "insertShapes",
      "moveShapes",
      "insertEdges",
      "moveEdges",
    ]));
  });

  it("keeps label replacements grapheme-safe and independent under concurrent edits", async () => {
    expect(canvasTextDiff("A👩🏽‍💻Z", "A👩🏽‍💻!Z")).toEqual({
      range: { from: 8, to: 8 },
      text: "!",
    });
    expect(canvasTextDiff("A👩🏽‍💻Z", "AZ")).toEqual({
      range: { from: 1, to: 8 },
      text: "",
    });

    const seed = createNmlYDoc(document());
    const left = new Y.Doc();
    const right = new Y.Doc();
    const update = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(left, update);
    Y.applyUpdate(right, update);
    const leftBefore = decodedScene(left);
    const rightBefore = decodedScene(right);
    const leftAfter = structuredClone(leftBefore);
    const rightAfter = structuredClone(rightBefore);
    leftAfter.nodes[0].label = `L${leftAfter.nodes[0].label}`;
    rightAfter.nodes[0].label = `${rightAfter.nodes[0].label}R`;
    rightAfter.nodes[0].style = { ...rightAfter.nodes[0].style, color: "#08f" };

    await execute(left, compileCanvasSceneChange("canvas", leftBefore, leftAfter).commands);
    await execute(right, compileCanvasSceneChange("canvas", rightBefore, rightAfter).commands);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(decodeNmlDocument(left)).toEqual(decodeNmlDocument(right));
    const merged = decodedScene(left).nodes[0];
    expect(merged.label).toBe("LAlpha 👩🏽‍💻R");
    expect(merged.style).toEqual({ background: "#fff", color: "#08f" });
  });

  it("preserves unseen collaborator fields, shapes, and edges when a stale gesture lands", async () => {
    const before = scene();
    const doc = createNmlYDoc(document(before));
    await execute(doc, [
      {
        type: "updateShapes",
        canvasId: "canvas",
        patches: [{ id: "r1", patch: { style: { background: "#fff", color: "#08f" } } }],
      },
      {
        type: "insertShapes",
        canvasId: "canvas",
        parentId: "group",
        shapes: [rect("remote-child", 260)],
      },
      {
        type: "insertEdges",
        canvasId: "canvas",
        edges: [edge("remote-edge", "remote-child", "r1")],
      },
    ]);

    const moved = applyOps(before, [{ type: "move", ids: ["r1"], dx: 25, dy: 5 }]);
    await execute(doc, compileCanvasSceneChange("canvas", before, moved).commands);
    let merged = decodedScene(doc);
    expect(merged.nodes[0]).toMatchObject({
      id: "r1",
      x: 35,
      y: 25,
      style: { background: "#fff", color: "#08f" },
    });

    const locallyRemoved = applyOps(before, [{ type: "remove", ids: ["group"] }]);
    await execute(doc, compileCanvasSceneChange("canvas", before, locallyRemoved).commands);
    merged = decodedScene(doc);
    expect(merged.nodes.some((node) => node.id === "group")).toBe(false);
    expect(merged.nodes.some((node) => node.id === "child-a" || node.id === "child-b")).toBe(false);
    expect(merged.nodes.some((node) => node.id === "remote-child")).toBe(true);
    expect(merged.edges.some((item) => item.id === "remote-edge")).toBe(true);
  });

  it("moves only the inserted edge when shared edge order did not change", () => {
    const before = scene();
    const after = structuredClone(before);
    after.edges.splice(1, 0, edge("edge-middle", "r1", "polygon"));
    const compiled = compileCanvasSceneChange("canvas", before, after);
    expect(compiled.commands.find((command) => command.type === "moveEdges")).toEqual({
      type: "moveEdges",
      canvasId: "canvas",
      placements: [{ id: "edge-middle", anchor: { afterId: "edge-a" } }],
    });
  });

  it("commits canvas edits without a ProseMirror document transaction and selects only the atom", async () => {
    const doc = createNmlYDoc(document());
    const bridge = new EditableNmlBridge(doc, {
      actor: { userId: "canvas-test", kind: "human" },
      authorize: () => true,
    });
    const updates = vi.fn();
    const sceneUpdates = vi.fn();
    bridge.subscribe(updates);
    const stopScene = bridge.subscribeCanvas("canvas", sceneUpdates);
    const pm = bridge.state.doc;
    const before = decodedScene(doc);
    const after = applyOps(before, [{ type: "move", ids: ["r1"], dx: 15, dy: 5 }]);

    expect(bridge.selectAtomicNode("canvas")).toBe(true);
    expect(bridge.state.selection).toMatchObject({ node: expect.objectContaining({ type: expect.objectContaining({ name: "nml_canvas" }) }) });
    expect(bridge.dispatchCanvasScene("canvas", before, after)).toBe(true);
    await Promise.resolve();
    expect(decodedScene(doc)).toEqual(after);
    expect(sceneUpdates).toHaveBeenCalledTimes(1);
    expect(bridge.state.doc).toBe(pm);
    const canvasUpdates = updates.mock.calls
      .map(([value]) => value)
      .filter((value) => value.changedNodeIds.includes("canvas"));
    expect(canvasUpdates.length).toBeGreaterThan(0);
    expect(canvasUpdates.every((value) => value.transaction === null)).toBe(true);
    expect(JSON.stringify(bridge.state.doc.toJSON())).not.toContain("scene");
    stopScene();
    bridge.destroy();
    doc.destroy();
  });

  it("rejects malformed kind changes and rolls an invalid command batch back atomically", async () => {
    const before = scene();
    const kindChanged = structuredClone(before);
    kindChanged.nodes[0] = { ...kindChanged.nodes[0], kind: "text" } as SceneNode;
    expect(() => compileCanvasSceneChange("canvas", before, kindChanged)).toThrow(/cannot change kind/);

    const doc = createNmlYDoc(document(before));
    const state = Y.encodeStateVector(doc);
    await expect(execute(doc, [
      { type: "updateCanvas", canvasId: "canvas", patch: { w: 1200 } },
      { type: "replaceShapeLabel", canvasId: "canvas", shapeId: "r1", range: { from: 7, to: 8 }, text: "x" },
    ])).rejects.toMatchObject({ code: "invalid_range", commandIndex: 1 });
    expect(Y.encodeStateVector(doc)).toEqual(state);
    expect(decodedScene(doc)).toEqual(before);
  });
});
