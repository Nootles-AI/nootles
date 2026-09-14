import { DOMParser } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { SceneStore } from "../engine/useScene";
import { migrateLegacyCanvas } from "../scene/migrate";
import { walk, type Scene } from "../scene/types";
import { CanvasCollab } from "./binding";
import { canvasMapName, materializeCanvas } from "./ymap";

/**
 * The binding between two people on one diagram: their maps, their scene
 * stores, and the block prop each mirrors the maps onto, over a network that
 * can hold updates back. `adoptExternal` is called with the prop as it stands,
 * the way the block reconciles one it did not write.
 */

// The binding parses mirrors itself, with no parser to inject.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const SOURCE = `<nt-diagram w="640" h="360">
  <nt-rect id="a" x="40" y="40" w="160" h="90" style="background: #f4c7c3"></nt-rect>
  <nt-rect id="b" x="360" y="40" w="160" h="90" style="background: #c3d7f4"></nt-rect>
</nt-diagram>`;

const WITH_C = (html: string) =>
  html.replace(
    "</nt-diagram>",
    `  <nt-rect id="c" x="220" y="220" w="120" h="80" style="background: #cfe8c9"></nt-rect>\n</nt-diagram>`,
  );

const RELAY = { relay: true };

const xs = (scene: Scene) => {
  const out: Record<string, number> = {};
  walk(scene.nodes, (node) => void (out[node.id] = node.x));
  return out;
};

function person(doc: Y.Doc) {
  const block = () => doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const prop = () => block().getAttribute("data") as string;
  const collab = new CanvasCollab("b1");
  collab.attach(doc, prop());
  const store = new SceneStore(collab.seed(prop()));
  let flushed: string | null = null;
  store.setWriter((html, scene) => {
    collab.writeLocal(html, scene);
    flushed = html;
  });
  collab.setStore(store);
  const refreshes: string[] = [];
  collab.onStaleMirror((html) => void refreshes.push(html));
  return {
    store,
    refreshes,
    prop,
    maps: () => xs(materializeCanvas(doc.getMap(canvasMapName("b1")))),
    shown: () => xs(store.getScene()),
    move(id: string, x: number) {
      const node = store.getNode(id)!;
      store.begin();
      store.dispatch({ type: "resize", frames: [{ id, x, y: node.y, w: node.w, h: node.h }] });
      store.commit();
    },
    writeProp(html: string, origin: unknown = null) {
      doc.transact(() => block().setAttribute("data", html), origin);
    },
    /** What the block does once the diagram has been quiet: flush, then mark and write the mirror in one task. */
    mirror() {
      store.flush();
      const html = collab.stampMirror(flushed ?? prop());
      doc.transact(() => block().setAttribute("data", html));
      return html;
    },
    /** What the block does with a prop it did not write. */
    reconcile() {
      collab.adoptExternal(prop());
    },
  };
}

function network(clientIds?: [number, number]) {
  const docs = [new Y.Doc(), new Y.Doc()] as const;
  if (clientIds) docs.forEach((doc, i) => (doc.clientID = clientIds[i]));
  const held: { to: Y.Doc; update: Uint8Array }[] = [];
  let holding = false;
  docs.forEach((from, i) => {
    const to = docs[1 - i];
    from.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === RELAY) return;
      if (holding) held.push({ to, update });
      else Y.applyUpdate(to, update, RELAY);
    });
  });
  docs[0].transact(() => {
    const block = new Y.XmlElement("canvas");
    block.setAttribute("data", SOURCE);
    docs[0].getXmlFragment("prosemirror").insert(0, [block]);
  });
  return {
    a: person(docs[0]),
    b: person(docs[1]),
    hold: () => void (holding = true),
    deliver: () => {
      holding = false;
      for (const { to, update } of held.splice(0)) Y.applyUpdate(to, update, RELAY);
    },
  };
}

// The stores debounce their flush; each test flushes by hand.
beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("a collaborator's mirror", () => {
  test("flushed while someone else was editing, it takes nothing back (NT-30)", () => {
    const { a, b, hold, deliver } = network();
    hold();
    a.move("a", 50);
    b.move("b", 250);
    b.mirror();
    deliver();
    a.reconcile();
    const both = { a: 50, b: 250 };
    expect([a.maps(), b.maps(), a.shown(), b.shown()]).toEqual([both, both, both, both]);
  });

  test("however many edits behind the maps it lands, it is recognised", () => {
    const { a, b } = network();
    b.move("b", 210);
    b.mirror();
    for (let i = 1; i <= 30; i++) b.move("b", 210 + i * 3);
    a.reconcile();
    expect([a.maps().b, b.maps().b, a.shown().b]).toEqual([300, 300, 300]);
  });

  test("its mark arriving on its own moves nothing and clears nobody's history", () => {
    const { a, b } = network();
    b.move("b", 250);
    b.store.flush();
    a.move("a", 60);
    expect(a.store.canUndo()).toBe(true);
    b.mirror();
    expect(a.store.canUndo()).toBe(true);
    expect(a.shown()).toEqual({ a: 60, b: 250 });
  });

  test("when two people's mirrors cross, the block and the maps settle on the same one", () => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ] as [number, number][]) {
      const { a, b, hold, deliver } = network(ids);
      hold();
      a.move("a", 50);
      a.mirror();
      b.move("b", 250);
      b.mirror();
      deliver();
      expect(a.prop()).toBe(b.prop());
      a.reconcile();
      b.reconcile();
      const both = { a: 50, b: 250 };
      expect([a.maps(), b.maps(), a.shown(), b.shown()]).toEqual([both, both, both, both]);
    }
  });
});

describe("an outside author", () => {
  test("a whole diagram written without the maps still diffs in for everyone", () => {
    const { a, b } = network();
    a.writeProp(WITH_C(a.prop()), "outside");
    a.reconcile();
    b.reconcile();
    expect([a.maps().c, b.maps().c, a.shown().c, b.shown().c]).toEqual([220, 220, 220, 220]);
  });

  test("…even written over a collaborator's mirror", () => {
    const { a, b } = network();
    b.move("b", 250);
    b.mirror();
    a.writeProp(WITH_C(a.prop()), "outside");
    a.reconcile();
    expect([a.maps(), b.shown()]).toEqual([
      { a: 40, b: 250, c: 220 },
      { a: 40, b: 250, c: 220 },
    ]);
  });
});

describe("the mirror on the block", () => {
  test("carries a collaborator's edit that arrived after the flush that asked for it", () => {
    const { a, b } = network();
    b.move("b", 250);
    b.store.flush();
    a.move("a", 70);
    b.mirror();
    expect(xs(migrateLegacyCanvas(b.prop()))).toEqual({ a: 70, b: 250 });
    expect(xs(migrateLegacyCanvas(a.prop()))).toEqual({ a: 70, b: 250 });
  });

  test("its writer is asked to bring it up to date when an edit arrives, and nobody else is", () => {
    const { a, b } = network();
    b.move("b", 250);
    b.mirror();
    a.move("a", 70);
    expect(b.refreshes.map((html) => xs(migrateLegacyCanvas(html)))).toEqual([{ a: 70, b: 250 }]);
    expect(a.refreshes).toEqual([]);

    // Once someone else's mirror replaces it, its writer is no longer asked.
    a.mirror();
    b.move("b", 260);
    expect(a.refreshes.map((html) => xs(migrateLegacyCanvas(html)))).toEqual([{ a: 70, b: 260 }]);
    a.move("a", 80);
    expect(b.refreshes).toHaveLength(1);
  });
});
