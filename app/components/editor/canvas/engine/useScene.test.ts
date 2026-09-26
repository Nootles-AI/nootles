import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { parseStoryboard } from "../../storyboard/parse";
import { serializeStoryboard } from "../../storyboard/serialize";
import { emptyStoryboard } from "../../storyboard/types";
import { readCanvasSource } from "../scene/migrate";
import { frameReader, SceneStore } from "./useScene";

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

describe("what a store reads", () => {
  const rect = { id: "r", kind: "rect", x: 50, y: 50, w: 100, h: 60, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} } as const;

  it("a diagram's store reads an old root as its band, and writes nothing for reading it", () => {
    const store = new SceneStore(diagram(40));
    const written: string[] = [];
    store.setWriter((html) => void written.push(html));
    expect([store.getScene().w, store.getScene().h]).toEqual([0, 260]);
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
