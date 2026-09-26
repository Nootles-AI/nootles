import { DOMParser } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { serializeScene } from "../scene/serialize";
import { SceneStore, type SceneHistoryEvent } from "./useScene";

(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const one = `<nt-diagram h="200"><nt-rect id="a" x="40" y="40" w="100" h="60"></nt-rect></nt-diagram>`;
const two =
  `<nt-diagram h="200"><nt-rect id="a" x="40" y="40" w="100" h="60"></nt-rect>` +
  `<nt-rect id="b" x="200" y="40" w="100" h="60"></nt-rect></nt-diagram>`;

function guarded(source = one) {
  const store = new SceneStore(source, undefined, true);
  const onEmpty = vi.fn();
  store.setOnEmpty(onEmpty);
  const events: SceneHistoryEvent[] = [];
  store.onHistory((event) => void events.push(event));
  return { store, onEmpty, events };
}

describe("the last-shape guard", () => {
  it("hands the edit that would take the last shape to the guard, and leaves the scene as it was", () => {
    const { store, onEmpty, events } = guarded();
    const before = store.getScene();
    store.dispatch({ type: "remove", ids: ["a"] });
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(store.getScene()).toBe(before);
    expect(events).toEqual([]);
  });

  it("lets every other edit through, a removal that leaves a shape included", () => {
    const { store, onEmpty } = guarded(two);
    store.dispatch({ type: "remove", ids: ["a"] });
    expect(onEmpty).not.toHaveBeenCalled();
    expect(store.getScene().nodes.map((n) => n.id)).toEqual(["b"]);
  });

  it("inside a bracket, commits what the bracket did as one entry first", () => {
    const { store, onEmpty, events } = guarded();
    store.begin();
    store.begin();
    store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    store.dispatch({ type: "remove", ids: ["a"] });
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(store.gesturing()).toBe(false);
    expect(store.getNode("a")?.x).toBe(50);
    expect(events).toEqual([{ type: "push", selectionOnly: false }]);
    // The callers' own commits are spent on a closed bracket.
    store.commit();
    store.commit();
    expect(events).toHaveLength(1);
  });

  it("is never asked about an abort, an undo, a redo or a remote scene", () => {
    const { store, onEmpty } = guarded(`<nt-diagram h="200"></nt-diagram>`);
    store.dispatch({
      type: "insert",
      nodes: [
        {
          id: "n",
          kind: "rect",
          x: 0,
          y: 24,
          w: 10,
          h: 10,
          rot: 0,
          style: {},
          label: "",
          locked: false,
          hidden: false,
          attrs: {},
        },
      ],
    });
    expect(store.undo()).toBe(true);
    expect(store.getScene().nodes).toHaveLength(0);
    expect(store.redo()).toBe(true);
    store.begin();
    store.dispatch({ type: "move", ids: ["n"], dx: 5, dy: 0 });
    store.abort();
    store.adoptRemote(`<nt-diagram h="140"></nt-diagram>`);
    expect(store.getScene().nodes).toHaveLength(0);
    store.setSource(one);
    store.setSource(`<nt-diagram h="120"></nt-diagram>`);
    expect(store.getScene().nodes).toHaveLength(0);
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it("stands aside for a tool taking back its own shape, without asserting at commit", () => {
    const { store, onEmpty } = guarded();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    store.begin();
    store.dispatch({ type: "remove", ids: ["a"] }, { guard: false });
    store.commit();
    expect(onEmpty).not.toHaveBeenCalled();
    expect(store.getScene().nodes).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("is opt-in: an unguarded store empties like any other edit", () => {
    const store = new SceneStore(one, undefined, true);
    store.dispatch({ type: "remove", ids: ["a"] });
    expect(store.getScene().nodes).toHaveLength(0);
  });
});

describe("SceneStore.forget", () => {
  it("drops both stacks and says so, keeping the scene", () => {
    const { store, events } = guarded(two);
    store.dispatch({ type: "move", ids: ["a"], dx: 5, dy: 0 });
    const scene = serializeScene(store.getScene());
    store.forget();
    expect(store.canUndo()).toBe(false);
    expect(serializeScene(store.getScene())).toBe(scene);
    expect(events.at(-1)).toEqual({ type: "clear" });
  });
});
