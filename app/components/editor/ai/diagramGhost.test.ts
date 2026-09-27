import { describe, expect, it } from "vitest";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import { bandHeight, EMPTY_BAND_H } from "../canvas/scene/band";
import type { Scene, SceneNode } from "../canvas/scene/types";
import type { Batch } from "@/convex/ai/operations";
import { diagramPhase, ghostBandHeight, phaseWord, PLANNING_LABEL } from "./diagramGhost";
import { ghostTextKey, ghostTextPlugin, type Suggestion } from "./ghostText";

const DIAGRAM = `<nt-diagram><nt-rect id="a" x="24" y="40" w="120" h="64">A</nt-rect><nt-rect id="b" x="240" y="140" w="120" h="64">B</nt-rect></nt-diagram>`;
const PARTIAL = `<nt-diagram><nt-rect id="a" x="24" y="40" w="120" h="64">A</nt-rect></nt-diagram>`;
const BATCH = { ops: [{ kind: "removeBlock", blockId: "x" }] } as unknown as Batch;

const action = (fields: Partial<Extract<Suggestion, { kind: "action" }>>): Suggestion => ({
  kind: "action",
  pos: 1,
  batch: null,
  ...fields,
});

describe("diagramPhase", () => {
  it("reads the three states off the suggestion", () => {
    expect(diagramPhase(action({ loading: true }))).toBe("thinking");
    expect(diagramPhase(action({ preview: { kind: "diagram", source: PARTIAL } }))).toBe("drawing");
    expect(
      diagramPhase(action({ preview: { kind: "diagram", source: PARTIAL }, onAccept: () => {} })),
    ).toBe("drawing");
    expect(diagramPhase(action({ preview: { kind: "diagram", source: DIAGRAM }, batch: BATCH }))).toBe(
      "waiting",
    );
  });

  it("is no phase for anything that is not a diagram", () => {
    expect(diagramPhase(null)).toBeNull();
    expect(diagramPhase({ kind: "ghost", text: "hi", pos: 1 })).toBeNull();
    expect(diagramPhase(action({ preview: { kind: "code", language: "ts", code: "x" } }))).toBeNull();
    expect(diagramPhase(action({ blocks: [{ type: "paragraph", html: "x" }] }))).toBeNull();
    expect(diagramPhase(action({ label: "Insert table", batch: BATCH }))).toBeNull();
  });
});

describe("ghostBandHeight", () => {
  it("opens at an empty band's height while thinking", () => {
    expect(ghostBandHeight("thinking", null)).toBe(EMPTY_BAND_H);
  });

  it("is the band's own height once there are shapes, so Tab lands it at that height", () => {
    const rect = (id: string, x: number, y: number) =>
      ({ id, kind: "rect", x, y, w: 120, h: 64, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} }) as SceneNode;
    const scene = { id: "d", w: 0, h: 0, style: {}, attrs: {}, nodes: [rect("a", 24, 40), rect("b", 240, 140)], edges: [] } as Scene;
    expect(bandHeight(scene)).toBeGreaterThan(EMPTY_BAND_H);
    expect(ghostBandHeight("drawing", scene)).toBe(bandHeight(scene));
    expect(ghostBandHeight("waiting", scene)).toBe(bandHeight(scene));
  });
});

describe("phaseWord", () => {
  it("names the drawing on the caret line, and leaves planning to the band", () => {
    expect(phaseWord("thinking")).toBeNull();
    expect(PLANNING_LABEL).toBe("Planning diagram");
    expect(phaseWord("drawing")).toBe("Drawing diagram");
    expect(phaseWord("waiting")).toBeNull();
  });
});

describe("the ghost's widget", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "text*", toDOM: () => ["p", 0] },
      text: {},
    },
  });
  const plugin = ghostTextPlugin();
  const start = () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Looks like this")])]);
    const state = EditorState.create({ doc, plugins: [plugin] });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 16)));
  };
  const show = (state: EditorState, s: Suggestion) => state.apply(state.tr.setMeta("nt-suggestion", s));
  const keys = (state: EditorState) =>
    (plugin.props.decorations!.call(plugin, state) as DecorationSet)
      .find()
      .map((d) => (d.spec as { key: string }).key);

  it("keeps one element from thinking to waiting, however many chunks arrive", () => {
    let state = start();
    const seen = new Set<string>();
    const ghostKey = () => keys(state).find((k) => k.startsWith("nt-diagram-ghost"));
    state = show(state, action({ pos: 16, loading: true, tail: ":" }));
    seen.add(ghostKey()!);
    for (const source of [PARTIAL, DIAGRAM]) {
      state = show(state, action({ pos: 16, preview: { kind: "diagram", source }, tail: ":" }));
      seen.add(ghostKey()!);
    }
    state = show(state, action({ pos: 16, preview: { kind: "diagram", source: DIAGRAM }, batch: BATCH, tail: ":" }));
    seen.add(ghostKey()!);
    expect([...seen]).toEqual(["nt-diagram-ghost-17"]);
    expect(ghostTextKey.getState(state)?.kind).toBe("action");
  });

  it("says its state at the caret, and redraws that line only when the state changes", () => {
    let state = start();
    const statusKey = () => keys(state).find((k) => k.startsWith("nt-diagram-status"));
    state = show(state, action({ pos: 16, loading: true }));
    const thinking = statusKey();
    state = show(state, action({ pos: 16, preview: { kind: "diagram", source: PARTIAL } }));
    const drawing = statusKey();
    state = show(state, action({ pos: 16, preview: { kind: "diagram", source: DIAGRAM } }));
    expect(statusKey()).toBe(drawing);
    state = show(state, action({ pos: 16, preview: { kind: "diagram", source: DIAGRAM }, batch: BATCH }));
    expect(new Set([thinking, drawing, statusKey()]).size).toBe(3);
  });
});
