import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import { SceneStore } from "./useScene";

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
