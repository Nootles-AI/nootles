import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { COLUMN_WIDTH } from "@/app/lib/column";
import { BAND, bandFloor, fitToBand } from "./scene/band";
import { nodeBounds } from "./scene/geometry";
import { emptyScene } from "./scene/migrate";
import { applyOps } from "./scene/ops";
import { canonicalPath } from "./scene/canonicalPaths";
import { parseScene, type ParseHtml } from "./scene/parse";
import { serializeScene } from "./scene/serialize";
import { walk, type Scene } from "./scene/types";
import { WIDE_DIAGRAM_SOURCE } from "./scene/bandSpan";
import { SceneStore, type SceneHistoryEvent } from "./engine/useScene";
import { PRESETS, presetOps } from "./presets";

// The store parses diagram HTML, and this environment has no DOM.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const parseHtml: ParseHtml = (h) => parseHTML(h).document as unknown as Document;
const parse = (html: string) => parseScene(html, parseHtml);

const labels = (scene: Scene) => scene.nodes.map((node) => node.label);

describe.each(PRESETS.map((preset) => [preset.id, preset] as const))("%s", (_, preset) => {
  const scene = parse(preset.html);

  it("parses to something", () => {
    expect(scene.nodes.length).toBeGreaterThan(0);
  });

  it("round-trips exactly", () => {
    expect(serializeScene(scene)).toBe(preset.html);
  });

  it("already fits its band, and is exactly as tall as its drawing needs", () => {
    expect(fitToBand(scene)).toBe(scene);
    expect(scene.h).toBe(bandFloor(scene));
  });

  it("sits in the column, a band below the top", () => {
    const boxes = scene.nodes.map(nodeBounds);
    expect(Math.min(...boxes.map((b) => b.y))).toBe(BAND);
    expect(Math.min(...boxes.map((b) => b.x))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...boxes.map((b) => b.x + b.w))).toBeLessThanOrEqual(COLUMN_WIDTH);
    expect(scene.wide).toBeUndefined();
  });

  it("names every shape and connector once", () => {
    const ids: string[] = [];
    walk(scene.nodes, (node) => void ids.push(node.id));
    ids.push(...scene.edges.map((edge) => edge.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("writes its paths the way the pen does, so opening one rewrites nothing", () => {
    walk(scene.nodes, (node) => {
      if (node.kind === "path") expect(canonicalPath(node.d)).toBe(node.d);
    });
  });
});

describe("the presets", () => {
  it("are few enough for one quiet bar", () => {
    expect(PRESETS.length).toBeLessThanOrEqual(6);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it("draw the flowchart asked for: a process into a condition, and two end states out of it", () => {
    const scene = parse(PRESETS.find((p) => p.id === "flowchart")!.html);
    expect(labels(scene)).toEqual(["Process", "Condition", "End state", "End state"]);
    const [process, condition, a, b] = scene.nodes;
    expect(condition).toMatchObject({ kind: "polygon", sides: 4 });
    for (const pill of [a, b]) expect(pill.style["border-radius"]).toBe(`${pill.h / 2}px`);
    expect(scene.edges.map((e) => [e.from, e.to])).toEqual([
      [process.id, condition.id],
      [condition.id, a.id],
      [condition.id, b.id],
    ]);
  });

  it("draw each mockup as one flattened shape", () => {
    for (const id of ["phone", "browser"]) {
      const scene = parse(PRESETS.find((p) => p.id === id)!.html);
      expect(scene.nodes.map((node) => node.kind)).toEqual(["path"]);
    }
  });
});

describe("presetOps", () => {
  const flowchart = PRESETS.find((p) => p.id === "flowchart")!;
  const empty = { ...emptyScene(), h: 74 };

  it("lands a preset in an empty diagram exactly where it was drawn, as one set of ops", () => {
    const { ops, ids } = presetOps(empty, flowchart, parseHtml);
    const after = applyOps(empty, ops);
    const drawn = parse(flowchart.html);
    expect(ids).toEqual(after.nodes.map((node) => node.id));
    expect(after.nodes.map(({ id: _id, ...rest }) => rest)).toEqual(drawn.nodes.map(({ id: _id, ...rest }) => rest));
    expect(after.edges).toHaveLength(3);
  });

  it("mints ids of the diagram's own, and the connectors follow them", () => {
    const held = applyOps(empty, presetOps(empty, flowchart, parseHtml).ops);
    const { ops, ids } = presetOps(held, flowchart, parseHtml);
    const after = applyOps(held, ops);
    expect(ids.some((id) => held.nodes.some((node) => node.id === id))).toBe(false);
    const fresh = new Set(ids);
    const added = after.edges.slice(held.edges.length);
    expect(added.every((edge) => fresh.has(edge.from) && fresh.has(edge.to))).toBe(true);
  });

  it("keeps a wide diagram wide, and puts the preset on the column inside it", () => {
    const wide: Scene = { ...empty, wide: "pinned" };
    const after = applyOps(wide, presetOps(wide, flowchart, parseHtml).ops);
    expect(after.wide).toBe("pinned");
    expect(after.nodes[0]).toMatchObject({ x: 286, y: 24 });
  });
});

describe("a preset chosen in a new diagram's store", () => {
  it.each(PRESETS.map((preset) => [preset.id, preset] as const))(
    "%s lands as one undo entry, raising the band to hold it, and one undo empties it again",
    (_, preset) => {
      for (const source of ["", WIDE_DIAGRAM_SOURCE]) {
        const store = new SceneStore(source, undefined, true);
        const before = store.getScene();
        const events: SceneHistoryEvent[] = [];
        store.onHistory((event) => void events.push(event));

        store.dispatch(presetOps(before, preset).ops);
        const drawn = parse(preset.html);
        expect(events).toEqual([{ type: "push", selectionOnly: false }]);
        expect(labels(store.getScene())).toEqual(labels(drawn));
        expect(store.getScene().h).toBe(drawn.h);
        expect(store.getScene().wide).toBe(before.wide);

        expect(store.undo()).toBe(true);
        expect(store.getScene().nodes).toEqual([]);
        expect(store.getScene().h).toBe(before.h);
      }
    },
  );
});
