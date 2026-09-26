import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import { BAND, bandFloor } from "../scene/band";
import { readCanvasSource } from "../scene/migrate";
import { frameReader, SceneStore, type SceneHistoryEvent } from "./useScene";

// The store parses diagram HTML, and this environment has no DOM.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const band = `<nt-diagram h="200"><nt-rect id="a" x="40" y="40" w="100" h="60"></nt-rect></nt-diagram>`;

describe("a band's store raises its height to hold a local edit", () => {
  it("in the same undo entry, and undo takes the height back with the edit", () => {
    const store = new SceneStore(band, undefined, true);
    const events: SceneHistoryEvent[] = [];
    store.onHistory((event) => void events.push(event));

    store.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 300 });
    expect(store.getNode("a")?.y).toBe(340);
    expect(store.getScene().h).toBe(340 + 60 + BAND);
    expect(store.getScene().h).toBe(bandFloor(store.getScene()));
    expect(events).toEqual([{ type: "push", selectionOnly: false }]);

    expect(store.undo()).toBe(true);
    expect(store.getNode("a")?.y).toBe(40);
    expect(store.getScene().h).toBe(200);
  });

  it("never lowers it: an edit that leaves room below keeps the stored height", () => {
    const store = new SceneStore(band, undefined, true);
    store.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 300 });
    const grown = store.getScene().h;
    store.dispatch({ type: "move", ids: ["a"], dx: 0, dy: -300 });
    expect(store.getScene().h).toBe(grown);
  });

  it("inside a gesture bracket, as one entry for the whole gesture", () => {
    const store = new SceneStore(band, undefined, true);
    const events: SceneHistoryEvent[] = [];
    store.onHistory((event) => void events.push(event));
    store.begin();
    store.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 150 });
    store.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 150 });
    store.commit();
    expect(store.getScene().h).toBe(340 + 60 + BAND);
    expect(events).toEqual([{ type: "push", selectionOnly: false }]);
    store.undo();
    expect(store.getScene().h).toBe(200);
  });

  it("only for a band: a store without the option, or a frame's, leaves h alone", () => {
    const plain = new SceneStore(band);
    plain.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 300 });
    expect(plain.getScene().h).toBe(200);

    const shot = `<nt-diagram w="320" h="180"><nt-rect id="a" x="10" y="10" w="40" h="40"></nt-rect></nt-diagram>`;
    const frame = new SceneStore(shot, frameReader({ w: 320, h: 180 }));
    frame.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 400 });
    expect(frame.getScene().h).toBe(readCanvasSource(shot).h);
  });

  it("never on what arrives from outside: a collaborator's scene adds no entry", () => {
    const store = new SceneStore(band, undefined, true);
    const tall = `<nt-diagram h="200"><nt-rect id="a" x="40" y="500" w="100" h="60"></nt-rect></nt-diagram>`;
    store.adoptRemote(tall);
    expect(store.getScene().h).toBe(bandFloor(store.getScene()));
    expect(store.canUndo()).toBe(false);
  });
});
