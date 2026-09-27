import { DOMParser } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { SceneStore } from "../engine/useScene";
import { migrateLegacyCanvas, readCanvasSource } from "../scene/migrate";
import { walk, type Scene } from "../scene/types";
import { CanvasCollab } from "./binding";
import { canvasMapName, materializeCanvas, populateCanvas } from "./ymap";

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
  let collab = new CanvasCollab("b1");
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
  let cleared = 0;
  store.onHistory((event) => void (event.type === "clear" && (cleared += 1)));
  return {
    store,
    refreshes,
    prop,
    /** How many times this person's undo horizon has been taken away. */
    clears: () => cleared,
    sizes: (id: string) => {
      const node = store.getNode(id)!;
      return { w: node.w, h: node.h };
    },
    /** What a ResizeObserver reports for an auto-sized text (`onMeasure`). */
    measure(id: string, w: number, h: number) {
      const node = store.getNode(id)!;
      store.measure([{ id, x: node.x, y: node.y, w, h }]);
    },
    /** What the picture hoist does once a fill is in storage (`hoistOps`). */
    readdress(id: string, background: string) {
      store.amend([{ type: "setStyle", ids: [id], decls: { background } }]);
    },
    /** A block view remounting onto the store kept warm behind it. */
    rebind() {
      collab.detach();
      collab = new CanvasCollab("b1");
      collab.attach(doc, prop());
      collab.setStore(store);
    },
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

/**
 * `measure` and `amend` change the model without anybody doing anything. They
 * are not edits where they happen, and NT-27 was that crossing to a
 * collaborator promoted them into one: the peer saw map keys move, read
 * concurrent work, and paid its documented price — a fresh undo horizon — for
 * a box nobody had typed.
 */
describe("a change nobody made", () => {
  test("a text's measured box crosses without costing anyone their undo (NT-27)", () => {
    const { a, b } = network();
    a.move("a", 60);
    expect(a.store.canUndo()).toBe(true);
    b.measure("b", 173, 91);
    expect([a.store.canUndo(), a.clears()]).toEqual([true, 0]);
  });

  test("so does a picture moved into storage", () => {
    const { a, b } = network();
    a.move("a", 60);
    b.readdress("b", "url(https://example.test/p.png)");
    expect([a.store.canUndo(), a.clears()]).toEqual([true, 0]);
  });

  test("the box still arrives — it is taken, only not charged for", () => {
    const { a, b } = network();
    a.move("a", 60);
    b.measure("b", 173, 91);
    expect(a.sizes("b")).toEqual({ w: 173, h: 91 });
    expect(a.maps().b).toBe(360);
    // And the person's own work is still on the surface, and still undoable.
    expect(a.shown().a).toBe(60);
    expect(a.store.canUndo()).toBe(true);
    a.store.undo();
    expect(a.shown().a).toBe(40);
  });

  /**
   * The horizon is kept, and an entry on it is still a whole scene from before
   * the box arrived — so stepping back to one carries the old box with it.
   * That is the honest cost of keeping the history, and it does not last: the
   * observer that measured the text reports again on the next layout
   * (`render/ShapeView.tsx`), and a re-addressed picture is re-addressed from
   * memory on the next notify (`blocks/CanvasBlock.tsx`). Both write the
   * housekeeping straight back. Nobody's WORK is reverted, which is the thing
   * `adoptRemote` exists to prevent.
   */
  test("stepping back over one carries the old box, and it is written straight back", () => {
    const { a, b } = network();
    a.move("a", 60);
    b.measure("b", 173, 91);
    a.store.undo();
    expect(a.sizes("b")).toEqual({ w: 160, h: 90 });
    // The next layout reports the box again, and it is news once more.
    a.measure("b", 173, 91);
    expect([a.sizes("b"), b.sizes("b")]).toEqual([
      { w: 173, h: 91 },
      { w: 173, h: 91 },
    ]);
    // B paid for A's move and for A's undo — both things A DID — and for
    // neither of the two measurements.
    expect(b.clears()).toBe(2);
  });

  test("a collaborator's actual edit still costs the horizon", () => {
    const { a, b } = network();
    a.move("a", 60);
    expect(a.store.canUndo()).toBe(true);
    b.move("b", 250);
    expect([a.store.canUndo(), a.clears()]).toEqual([false, 1]);
  });

  test("housekeeping flushed together with an edit is an edit", () => {
    const { a, b, hold, deliver } = network();
    a.move("a", 60);
    hold();
    b.measure("b", 173, 91);
    b.move("b", 250);
    deliver();
    expect([a.store.canUndo(), a.clears()]).toEqual([false, 1]);
  });

  test("one that lands mid-gesture is taken at the end, and still costs nothing", () => {
    const { a, b } = network();
    a.move("a", 60);
    a.store.begin();
    b.measure("b", 173, 91);
    // Held while the gesture is open, exactly as a collaborator's edit is.
    expect(a.sizes("b")).toEqual({ w: 160, h: 90 });
    a.store.commit();
    expect(a.sizes("b")).toEqual({ w: 173, h: 91 });
    expect([a.store.canUndo(), a.clears()]).toEqual([true, 0]);
  });

  test("a collaborator's edit that lands mid-gesture still costs it", () => {
    const { a, b } = network();
    a.move("a", 60);
    a.store.begin();
    b.move("b", 250);
    a.store.commit();
    expect([a.store.canUndo(), a.clears()]).toEqual([false, 1]);
  });

  /**
   * The reason this one is worth its own test: the two browsers never agree,
   * so they never stop correcting each other. Before the fix, every round of
   * that cost both of them their horizon — a diagram two people had open was
   * one nobody could undo on.
   */
  test("two browsers that measure the same words differently stop wiping each other", () => {
    const { a, b } = network();
    a.move("a", 60);
    const beforeA = a.clears();
    const beforeB = b.clears();
    for (let i = 0; i < 8; i++) {
      a.measure("b", 161, 91);
      b.measure("b", 160, 91);
    }
    // Eight rounds of disagreement, and nobody was charged for any of it.
    expect([a.clears() - beforeA, b.clears() - beforeB]).toEqual([0, 0]);
    expect(a.store.canUndo()).toBe(true);
    a.store.undo();
    expect(a.shown().a).toBe(40);
  });

  test("a store kept warm through a remount still yields to what arrived while it was away", () => {
    const { a, b } = network();
    a.move("a", 60);
    expect(a.store.canUndo()).toBe(true);
    // The block view goes and comes back; the store — and its history — stay.
    a.rebind();
    expect(a.store.canUndo()).toBe(true);
    b.move("b", 250);
    expect([a.store.canUndo(), a.clears()]).toEqual([false, 1]);
  });

  test("a remount over a collaborator's edit made while away clears, as it always did", () => {
    const docs = network();
    docs.a.move("a", 60);
    docs.b.measure("b", 173, 91);
    // The horizon survived the box…
    expect(docs.a.store.canUndo()).toBe(true);
    // …and the rebind does not invent an arrival of its own.
    docs.a.rebind();
    expect(docs.a.store.canUndo()).toBe(true);
    expect(docs.a.sizes("b")).toEqual({ w: 173, h: 91 });
  });

  /**
   * The quiet path answers to a token, and a diagram written before the key
   * existed carries none. It still costs the horizon then — which costs
   * nothing real, because a horizon you can lose is one an edit gave you, and
   * that edit minted the token.
   */
  test("on a diagram nobody has edited yet it still clears, and the first edit settles it", () => {
    const { a, b } = network();
    // No edit anywhere: the maps carry no token.
    b.measure("b", 173, 91);
    expect(a.store.canUndo()).toBe(false); // nothing to lose in the first place
    // One edit mints one, and from then on the browser's work is free.
    a.move("a", 60);
    const before = a.clears();
    b.measure("b", 174, 92);
    b.readdress("b", "#abcdef");
    expect([a.clears() - before, a.store.canUndo()]).toEqual([0, true]);
  });

  test("an outside author's whole diagram is work, and still costs the horizon", () => {
    const { a, b } = network();
    b.move("b", 250);
    expect(b.store.canUndo()).toBe(true);
    // An agent writes the whole diagram onto the block with no maps behind it.
    a.writeProp(WITH_C(a.prop()), "outside");
    a.reconcile();
    expect([b.store.canUndo(), b.clears()]).toEqual([false, 1]);
    expect(b.shown().c).toBe(220);
  });

  test("the diagram is the same on both sides afterwards", () => {
    const { a, b } = network();
    a.move("a", 60);
    b.measure("b", 173, 91);
    a.readdress("a", "#123456");
    expect(a.maps()).toEqual(b.maps());
    expect(a.shown()).toEqual(b.shown());
    expect(a.sizes("b")).toEqual(b.sizes("b"));
  });
});

/**
 * Maps a client wrote before bands hold the old root, and the store reads the
 * band it becomes. Nothing has changed between the two, so nothing is news.
 */
describe("maps from before bands", () => {
  function oldMaps() {
    const doc = new Y.Doc();
    doc.transact(() => {
      const block = new Y.XmlElement("canvas");
      block.setAttribute("data", SOURCE);
      doc.getXmlFragment("prosemirror").insert(0, [block]);
      populateCanvas(doc.getMap(canvasMapName("b1")), readCanvasSource(SOURCE));
    });
    return doc;
  }

  test("a warm store keeps its history across a remount", () => {
    const doc = oldMaps();
    const store = new SceneStore(SOURCE);
    store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    store.dispatch({ type: "move", ids: ["a"], dx: -10, dy: 0 });
    // Its own flush put the band's form down as what it last wrote.
    store.flush();
    let cleared = 0;
    store.onHistory((event) => void (event.type === "clear" && (cleared += 1)));

    const collab = new CanvasCollab("b1");
    collab.attach(doc, SOURCE);
    collab.setStore(store);
    expect([store.canUndo(), cleared]).toEqual([true, 0]);
  });

  test("the first edit writes the band's root into the maps", () => {
    const doc = oldMaps();
    const collab = new CanvasCollab("b1");
    collab.attach(doc, SOURCE);
    const store = new SceneStore(collab.seed(SOURCE));
    collab.setStore(store);
    const meta = () => (doc.getMap(canvasMapName("b1")).get("meta") as Y.Map<unknown>).toJSON();
    expect(meta().w).toBe(640);

    store.dispatch({ type: "move", ids: ["a"], dx: 10, dy: 0 });
    expect([meta().w, meta().h]).toEqual([undefined, 260]);
    expect(materializeCanvas(doc.getMap(canvasMapName("b1")))).toEqual(store.getScene());
  });
});

/**
 * A local edit can leave a band storing less height than its content is drawn
 * at. The maps then hold exactly what the store does, and a re-attach — a
 * review's fork swapping in — must read that as nothing new.
 */
describe("a band outgrowing its stored height", () => {
  test("a re-attach before the flush keeps the history and the flush", () => {
    const source = `<nt-diagram h="120">
  <nt-rect id="a" x="40" y="24" w="160" h="72"></nt-rect>
</nt-diagram>`;
    const doc = new Y.Doc();
    doc.transact(() => {
      const block = new Y.XmlElement("canvas");
      block.setAttribute("data", source);
      doc.getXmlFragment("prosemirror").insert(0, [block]);
    });
    const collab = new CanvasCollab("b1");
    collab.attach(doc, source);
    const store = new SceneStore(collab.seed(source));
    let writes = 0;
    store.setWriter((html, scene) => {
      collab.writeLocal(html, scene);
      writes += 1;
    });
    collab.setStore(store);
    let cleared = 0;
    store.onHistory((event) => void (event.type === "clear" && (cleared += 1)));

    store.dispatch({ type: "move", ids: ["a"], dx: 0, dy: 100 });
    expect(store.getScene().h).toBeLessThan(196);
    collab.attach(doc, source);
    store.flush();
    expect([store.canUndo(), cleared, writes]).toEqual([true, 0, 1]);
  });
});
