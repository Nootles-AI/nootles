import { DOMParser } from "linkedom";
import { duringAiApply } from "@/app/lib/debugRing";
import { describe, expect, it } from "vitest";
import { BAND, bandFloor } from "../scene/band";
import { laidOutScene } from "../scene/autoLayout";
import { edgePoints } from "../scene/edgePath";
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

describe("a wide band folds back to the column once nothing uses its margins", () => {
  // `a` sits in the column; `m` reaches into the left margin.
  const wide = `<nt-diagram h="200" wide><nt-rect id="a" x="40" y="40" w="100" h="60"></nt-rect><nt-rect id="m" x="-200" y="40" w="100" h="60"></nt-rect></nt-diagram>`;

  it("after the local edit that empties the margins, in that edit's entry", () => {
    const store = new SceneStore(wide, undefined, true);
    const events: SceneHistoryEvent[] = [];
    store.onHistory((event) => void events.push(event));
    store.dispatch({ type: "move", ids: ["m"], dx: 400, dy: 0 });
    expect(store.getScene().wide).toBeUndefined();
    expect(events).toEqual([{ type: "push", selectionOnly: false }]);

    expect(store.undo()).toBe(true);
    expect(store.getScene().wide).toBe(true);
    expect(store.getNode("m")?.x).toBe(-200);
  });

  it("not while anything still reaches past the column", () => {
    const store = new SceneStore(wide, undefined, true);
    store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    expect(store.getScene().wide).toBe(true);
    store.dispatch({ type: "move", ids: ["m"], dx: 150, dy: 0 });
    expect(store.getNode("m")?.x).toBe(-50);
    expect(store.getScene().wide).toBe(true);
  });

  it("counts a rotated box by its turned bounds, and ignores hidden shapes", () => {
    const turned = `<nt-diagram h="200" wide><nt-rect id="r" x="0" y="40" w="200" h="20" rotation="90"></nt-rect><nt-rect id="h" x="-200" y="40" w="100" h="60" hidden></nt-rect></nt-diagram>`;
    const store = new SceneStore(turned, undefined, true);
    // Unturned it would sit at 0..200; turned about its centre it spans 90..110.
    store.dispatch({ type: "move", ids: ["r"], dx: 0, dy: 10 });
    expect(store.getScene().wide).toBeUndefined();

    const reaching = new SceneStore(turned.replace('x="0"', 'x="-95"'), undefined, true);
    // Turned, it spans -5..15 — past the column's left edge.
    reaching.dispatch({ type: "move", ids: ["r"], dx: 0, dy: 10 });
    expect(reaching.getScene().wide).toBe(true);
  });

  it("counts a connector routed through the margin", () => {
    // A wall the full column wide between `a` and `b` sends the route round it.
    const routed = `<nt-diagram h="400" wide><nt-rect id="a" x="0" y="20" w="100" h="60"></nt-rect><nt-rect id="wall" x="0" y="150" w="720" h="60"></nt-rect><nt-rect id="b" x="0" y="300" w="100" h="60"></nt-rect><nt-edge id="e" from="a" to="b"></nt-edge></nt-diagram>`;
    const store = new SceneStore(routed, undefined, true);
    const points = edgePoints(laidOutScene(store.getScene()), store.getScene().edges[0]) ?? [];
    expect(points.some((p) => p.x < 0 || p.x > 720)).toBe(true);
    store.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 10 });
    expect(store.getScene().wide).toBe(true);
  });

  it("never on turning Wide on by hand — it waits for the next edit", () => {
    const narrow = `<nt-diagram h="200"><nt-rect id="a" x="40" y="40" w="100" h="60"></nt-rect></nt-diagram>`;
    const store = new SceneStore(narrow, undefined, true);
    store.dispatch({ type: "setDiagram", wide: true });
    expect(store.getScene().wide).toBe(true);
    store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    expect(store.getScene().wide).toBeUndefined();
  });

  it("at the end of a gesture, never mid-way, as one entry", () => {
    const store = new SceneStore(wide, undefined, true);
    const events: SceneHistoryEvent[] = [];
    store.onHistory((event) => void events.push(event));
    store.begin();
    store.dispatch({ type: "move", ids: ["m"], dx: 400, dy: 0 });
    expect(store.getScene().wide).toBe(true);
    store.dispatch({ type: "move", ids: ["m"], dx: -400, dy: 0 });
    store.dispatch({ type: "move", ids: ["m"], dx: 400, dy: 0 });
    store.commit();
    expect(store.getScene().wide).toBeUndefined();
    expect(events).toEqual([{ type: "push", selectionOnly: false }]);
    store.undo();
    expect(store.getScene().wide).toBe(true);
    expect(store.getNode("m")?.x).toBe(-200);
  });

  it("not for a gesture that turned Wide on, nor one abandoned", () => {
    const narrow = `<nt-diagram h="200"><nt-rect id="a" x="40" y="40" w="100" h="60"></nt-rect></nt-diagram>`;
    const store = new SceneStore(narrow, undefined, true);
    store.begin();
    store.dispatch({ type: "setDiagram", wide: true });
    store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    store.commit();
    expect(store.getScene().wide).toBe(true);

    const abandoned = new SceneStore(wide, undefined, true);
    abandoned.begin();
    abandoned.dispatch({ type: "move", ids: ["m"], dx: 400, dy: 0 });
    abandoned.abort();
    expect(abandoned.getScene().wide).toBe(true);
  });

  it("never for the model's edits", () => {
    const store = new SceneStore(wide, undefined, true);
    duringAiApply(() => store.dispatch({ type: "move", ids: ["m"], dx: 400, dy: 0 }));
    expect(store.getScene().wide).toBe(true);
  });

  it("never for a frame, nor for what arrives from outside", () => {
    const shot = `<nt-diagram w="320" h="180" wide><nt-rect id="a" x="10" y="10" w="40" h="40"></nt-rect></nt-diagram>`;
    const frame = new SceneStore(shot, frameReader({ w: 320, h: 180 }));
    frame.dispatch({ type: "move", ids: ["a"], dx: 5, dy: 0 });
    expect(frame.getScene().wide).toBe(true);

    const store = new SceneStore(wide, undefined, true);
    store.adoptRemote(wide.replace('x="-200"', 'x="200"'));
    expect(store.getScene().wide).toBe(true);
    expect(store.canUndo()).toBe(false);
  });
});
