import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { parseStoryboard } from "../../storyboard/parse";
import { serializeStoryboard } from "../../storyboard/serialize";
import { emptyStoryboard } from "../../storyboard/types";
import { readCanvasSource } from "../scene/migrate";
import type { SceneOp } from "../scene/types";
import { frameReader, SceneStore, type SceneHistoryEvent } from "./useScene";

// The store parses diagram HTML, and this environment has no DOM.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const diagram = (x: number) =>
  `<nt-diagram w="400" h="300"><nt-rect id="a" x="${x}" y="40" w="100" h="60"></nt-rect></nt-diagram>`;

describe("SceneStore.arriving", () => {
  it("is true only while listeners hear a scene that came from outside", () => {
    const store = new SceneStore(diagram(40));
    const heard: boolean[] = [];
    store.subscribe(() => void heard.push(store.arriving()));

    store.adoptRemote(diagram(80));
    store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    store.adoptQuiet(diagram(120));
    store.setSource(diagram(160));

    expect(heard).toEqual([true, false, true, true]);
    expect(store.arriving()).toBe(false);
  });

  it("stays true for later listeners when an earlier one edits in between", () => {
    const store = new SceneStore(diagram(40));
    let edited = false;
    store.subscribe(() => {
      if (edited) return;
      edited = true;
      store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    });
    const heard: boolean[] = [];
    store.subscribe(() => void heard.push(store.arriving()));

    store.adoptRemote(diagram(80));

    // The nested edit's notification first, then the arrival's own.
    expect(heard).toEqual([false, true]);
  });
});

describe("SceneStore.settle", () => {
  const nudge: SceneOp = { type: "move", ids: ["a"], dx: 10, dy: 0 };

  /** A run held open on an idle timer, closing on the store's before-step hook. */
  function idleRun(store: SceneStore) {
    let open = false;
    store.onBeforeStep(() => {
      if (!open) return;
      open = false;
      store.commit();
    });
    return () => {
      if (!open) store.begin();
      open = true;
      store.dispatch(nudge);
    };
  }

  it("closes an idle-held bracket into one entry, without stepping", () => {
    const store = new SceneStore(diagram(40));
    const events: SceneHistoryEvent[] = [];
    store.onHistory((event) => void events.push(event));
    const run = idleRun(store);
    run();
    run();
    expect(store.gesturing()).toBe(true);

    store.settle();
    expect(store.gesturing()).toBe(false);
    expect(events).toEqual([{ type: "push", selectionOnly: false }]);
    expect(store.getNode("a")?.x).toBe(60);
    expect(store.undo()).toBe(true);
    expect(store.getNode("a")?.x).toBe(40);
  });

  it("is a no-op with nothing held, and leaves a live gesture open", () => {
    const store = new SceneStore(diagram(40));
    const events: SceneHistoryEvent[] = [];
    store.onHistory((event) => void events.push(event));
    idleRun(store);
    const scene = store.getScene();

    store.settle();
    expect(store.getScene()).toBe(scene);
    expect(store.canUndo()).toBe(false);

    store.begin(); // a drag in hand: no hook closes it
    store.dispatch(nudge);
    store.settle();
    expect(store.gesturing()).toBe(true);
    expect(store.undo()).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("what a store reads", () => {
  const rect = { id: "r", kind: "rect", x: 50, y: 50, w: 100, h: 60, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} } as const;

  it("a diagram's store reads an old root as its band, and writes nothing for reading it", () => {
    const store = new SceneStore(diagram(40));
    const written: string[] = [];
    store.setWriter((html) => void written.push(html));
    expect([store.getScene().w, store.getScene().h]).toEqual([0, 0]);
    store.flush();
    expect(written).toEqual([]);
  });

  it("an empty shot is born at its frame's size, so its first drawing reads back at 1×", () => {
    vi.useFakeTimers();
    try {
      const store = new SceneStore("", frameReader({ w: 320, h: 180 }));
      expect([store.getScene().w, store.getScene().h]).toEqual([320, 180]);
      let written = "";
      store.setWriter((html) => void (written = html));
      store.dispatch({ type: "insert", nodes: [rect] });
      store.flush();
      expect(written.startsWith(`<nt-diagram w="320" h="180">`)).toBe(true);

      // Through the board and back — the path that used to shrink it to a third.
      const board = emptyStoryboard(1);
      board.shots[0].scene = written;
      const dom = (html: string) => parseHTML(html).document as unknown as Document;
      const shot = parseStoryboard(serializeStoryboard(board), dom).shots[0].scene;
      const node = readCanvasSource(shot, dom).nodes[0];
      expect([node.x, node.y, node.w, node.h]).toEqual([50, 50, 100, 60]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a frame's store keeps its root as written", () => {
    const shot = `<nt-diagram w="320" h="180"><nt-rect id="a" x="400" y="-20" w="100" h="60"></nt-rect></nt-diagram>`;
    const scene = new SceneStore(shot, frameReader({ w: 320, h: 180 })).getScene();
    expect([scene.w, scene.h, scene.wide, scene.nodes[0].x, scene.nodes[0].y]).toEqual([320, 180, undefined, 400, -20]);
  });
});

describe("SceneStore.abort", () => {
  it("puts back the scene the gesture opened on, with no entry and no edit", () => {
    const store = new SceneStore(diagram(40));
    const before = store.getScene();
    const events: SceneHistoryEvent[] = [];
    store.onHistory((event) => void events.push(event));
    const live: boolean[] = [];
    store.setLiveWriter((_scene, edit) => void live.push(edit));

    store.begin();
    store.dispatch({ type: "remove", ids: ["a"] });
    expect(store.getScene().nodes).toHaveLength(0);
    store.abort();

    expect(store.getScene()).toBe(before);
    expect(store.gesturing()).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(events).toEqual([]);
    expect(live.at(-1)).toBe(false);
  });

  it("closes every level of a nested bracket", () => {
    const store = new SceneStore(diagram(40));
    store.begin();
    store.begin();
    store.dispatch({ type: "move", ids: ["a"], dx: 5, dy: 0 });
    store.abort();
    expect(store.gesturing()).toBe(false);
    store.commit();
    expect(store.canUndo()).toBe(false);
  });

  it("takes in a source that arrived while the gesture held it off", () => {
    const store = new SceneStore(diagram(40));
    store.begin();
    store.setSource(diagram(90));
    expect(store.getScene().nodes[0].x).toBe(40);
    store.abort();
    expect(store.getScene().nodes[0].x).toBe(90);
  });

  it("does nothing outside a gesture", () => {
    const store = new SceneStore(diagram(40));
    const before = store.getScene();
    store.abort();
    expect(store.getScene()).toBe(before);
  });
});
