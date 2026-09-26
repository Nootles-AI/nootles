import { DOMParser as LinkedomParser } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceHistory } from "@/app/lib/history/spine";
import { SceneStore } from "../engine/useScene";
import { createSelectionStore, type SelectionStore } from "../engine/useSelection";
import { laidOutScene } from "../scene/autoLayout";
import type { CanvasApi } from "../render/CanvasSurface";
import { createPageSelection } from "./pageSelection";
import { createPageCanvas, createPageCanvasHub, type DiagramEntry } from "./PageCanvas";

/**
 * Just enough of a selection store: ids, edges, the hover that moves the
 * snapshot too, and a click that hits `n<x>` for any x above zero.
 */
function fakeStore() {
  let snap = {
    ids: [] as string[],
    edgeIds: [] as string[],
    hoverId: null as string | null,
    enteredPath: [] as string[],
  };
  const listeners = new Set<() => void>();
  const write = (next: Partial<typeof snap>) => {
    snap = { ...snap, ...next };
    for (const l of listeners) l();
  };
  const select = (ids: readonly string[]) => write({ ids: [...ids], edgeIds: [] });
  const toggle = (id: string) =>
    select(snap.ids.includes(id) ? snap.ids.filter((x) => x !== id) : [...snap.ids, id]);
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    getSnapshot: () => snap,
    isSelected: (id: string) => snap.ids.includes(id),
    select,
    toggle,
    selectEdges: (edgeIds: readonly string[]) => write({ ids: [], edgeIds: [...edgeIds] }),
    toggleEdge: (id: string) => write({ ids: [], edgeIds: [...snap.edgeIds, id] }),
    clear: () => {
      if (snap.ids.length || snap.edgeIds.length) write({ ids: [], edgeIds: [] });
    },
    click: (point: { x: number }, mods?: { shift?: boolean }) => {
      const hit = point.x > 0 ? `n${point.x}` : null;
      if (mods?.shift) {
        if (hit) toggle(hit);
      } else if (hit) {
        select([hit]);
      } else if (snap.ids.length || snap.edgeIds.length) {
        write({ ids: [], edgeIds: [] });
      }
      return hit;
    },
    escape: () => write({ ids: [], edgeIds: [] }),
    marquee: (rect: { x: number; w: number }, mods?: { shift?: boolean }) => {
      const hits = rect.w > 0 ? [`m${rect.x}`] : [];
      select(mods?.shift ? [...new Set([...snap.ids, ...hits])] : hits);
    },
    hover: (hoverId: string | null) => write({ hoverId }),
  } as unknown as SelectionStore & {
    selectEdges(ids: readonly string[]): void;
    hover(id: string | null): void;
  };
}

/** Counts steps the way the spine does: a batch inside a batch is the same step. */
const counting = () => {
  const count = { batches: 0 };
  let depth = 0;
  return {
    count,
    batch: <T,>(fn: () => T): T => {
      if (depth === 0) count.batches++;
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    },
  };
};

const plain = () => createPageSelection({ batch: (fn) => fn() });

describe("page selection", () => {
  it("a plain selection in one diagram clears the others", () => {
    const page = plain();
    const a = fakeStore();
    const b = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    a.select(["a1"]);
    b.select(["b1"]);
    expect(a.getSnapshot().ids).toEqual([]);
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b"]);
    expect(page.getSnapshot().focused).toBe("b");
  });

  it("an additive selection keeps the others", () => {
    const page = plain();
    const a = fakeStore();
    const b = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    page.selectIn("a", ["a1"]);
    page.selectIn("b", ["b1"], { keep: true });
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b", "a"]);
    expect(page.getSnapshot().focused).toBe("b");
    page.selectIn("a", ["a2"]);
    expect([...page.getSnapshot().parts.keys()]).toEqual(["a"]);
  });

  it("focus falls to the last diagram still holding a selection, then to nothing", () => {
    const page = plain();
    const a = fakeStore();
    const b = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    page.selectIn("a", ["a1"]);
    page.selectIn("b", ["b1"], { keep: true });
    b.clear();
    expect(page.getSnapshot().focused).toBe("a");
    a.clear();
    expect(page.getSnapshot().focused).toBeNull();
  });

  it("keeps the recent diagram after its selection is gone, and a focus request moves it", () => {
    const page = plain();
    const a = fakeStore();
    page.attach("a", a);
    page.attach("b", fakeStore());
    a.select(["a1"]);
    a.clear();
    expect(page.getSnapshot()).toMatchObject({ focused: null, recent: "a" });
    page.focus("b");
    expect(page.getSnapshot()).toMatchObject({ focused: null, recent: "b" });
  });

  it("ignores hover: the snapshot stays the same object", () => {
    const page = plain();
    const a = fakeStore();
    page.attach("a", a);
    a.select(["a1"]);
    const before = page.getSnapshot();
    a.hover("a2");
    expect(page.getSnapshot()).toBe(before);
  });

  it("an edge selection holds focus like a shape selection", () => {
    const page = plain();
    const a = fakeStore();
    page.attach("a", a);
    a.selectEdges(["e1"]);
    expect(page.getSnapshot().focused).toBe("a");
  });

  it("clears the others in one batch", () => {
    let batches = 0;
    const page = createPageSelection({
      batch: <T,>(fn: () => T): T => {
        batches++;
        return fn();
      },
    });
    const a = fakeStore();
    const b = fakeStore();
    const c = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    page.attach("c", c);
    page.selectIn("a", ["a1"]);
    page.selectIn("b", ["b1"], { keep: true });
    batches = 0;
    c.select(["c1"]);
    expect(batches).toBe(1);
    expect([...page.getSnapshot().parts.keys()]).toEqual(["c"]);
  });

  it("while history restores a selection, nothing else is cleared", () => {
    let restoring = false;
    const page = createPageSelection({ batch: (fn) => fn(), quiet: () => restoring });
    const a = fakeStore();
    const b = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    a.select(["a1"]);
    restoring = true;
    b.select(["b1"]);
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b", "a"]);
  });

  it("forgets a diagram that detaches", () => {
    const page = plain();
    const a = fakeStore();
    const off = page.attach("a", a);
    a.select(["a1"]);
    off();
    expect(page.getSnapshot().focused).toBeNull();
    a.select(["a2"]);
    expect(page.getSnapshot().parts.size).toBe(0);
  });
});

const entry = (blockId: string, selection = fakeStore()): DiagramEntry => ({
  blockId,
  api: { selection, ownSelection: selection, band: { current: null } } as unknown as CanvasApi,
  readOnly: false,
  flushMirror: () => {},
  remove: () => {},
  blocks: {} as DiagramEntry["blocks"],
});

describe("the page's facade over a diagram's selection", () => {
  const two = (deps: Partial<Parameters<typeof createPageSelection>[0]> = {}) => {
    const page = createPageSelection({ batch: (fn) => fn(), ...deps });
    const a = fakeStore();
    const b = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    return { page, a, b, fa: page.facade("a", a), fb: page.facade("b", b) };
  };

  it("is the same object every time it is asked for", () => {
    const { page, a, fa } = two();
    expect(page.facade("a", a)).toBe(fa);
  });

  it("a plain click clears the other diagrams, in one step", () => {
    const { count, batch } = counting();
    const { fa, fb, a } = two({ batch });
    fa.click({ x: 1, y: 0 });
    count.batches = 0;
    fb.click({ x: 2, y: 0 });
    expect(a.getSnapshot().ids).toEqual([]);
    expect(count.batches).toBe(1);
  });

  it("a plain click on empty canvas clears the whole page", () => {
    const { page, fa, fb } = two();
    fa.click({ x: 1, y: 0 });
    fb.click({ x: 0, y: 0 });
    expect(page.getSnapshot().parts.size).toBe(0);
  });

  it("a Shift-click adds to the page's selection, and focus follows it", () => {
    const { page, fa, fb } = two();
    fa.click({ x: 1, y: 0 });
    fb.click({ x: 2, y: 0 }, { shift: true });
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b", "a"]);
    expect(page.getSnapshot().focused).toBe("b");
    expect(page.count()).toBe(2);
  });

  it("a ⌘-toggle keeps the others too", () => {
    const { page, fa, fb } = two();
    fa.click({ x: 1, y: 0 });
    fb.toggle("b1");
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b", "a"]);
  });

  it("shapes added in one diagram let another's connectors go", () => {
    const { page, fa, fb, a } = two();
    fa.selectEdges(["e1"]);
    fb.click({ x: 2, y: 0 }, { shift: true });
    expect(a.getSnapshot().edgeIds).toEqual([]);
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b"]);
  });

  it("a connector is never selected beside another diagram's anything", () => {
    const { page, fa, fb } = two();
    fa.click({ x: 1, y: 0 });
    fb.toggleEdge("e1");
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b"]);
  });

  it("clear clears the page in one step, and costs nothing when there is nothing", () => {
    const { count, batch } = counting();
    const { page, fa, fb } = two({ batch });
    count.batches = 0;
    fa.clear();
    expect(count.batches).toBe(0);
    fa.click({ x: 1, y: 0 });
    fb.click({ x: 2, y: 0 }, { shift: true });
    count.batches = 0;
    fa.clear();
    expect(page.getSnapshot().parts.size).toBe(0);
    expect(count.batches).toBe(1);
  });

  it("Escape at the top level clears the page", () => {
    const { page, fa, fb } = two();
    fa.click({ x: 1, y: 0 });
    fb.click({ x: 2, y: 0 }, { shift: true });
    fb.escape();
    expect(page.getSnapshot().parts.size).toBe(0);
  });

  it("a range from the layers keeps the others; a plain one replaces them", () => {
    const { page, fa } = two();
    fa.click({ x: 1, y: 0 });
    page.selectIn("b", ["b1", "b2"], { keep: true });
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b", "a"]);
    page.selectIn("b", ["b3"]);
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b"]);
  });

  it("one marquee reaches into several diagrams without one clearing another", () => {
    const { page } = two();
    page.marqueeIn("a", { x: 5, y: 0, w: 10, h: 10 }, { shift: false });
    page.marqueeIn("b", { x: 7, y: 0, w: 10, h: 10 }, { shift: false });
    expect(page.getSnapshot().parts.get("a")?.ids).toEqual(["m5"]);
    expect(page.getSnapshot().parts.get("b")?.ids).toEqual(["m7"]);
    // The rubber band has left `a`: its share goes.
    page.marqueeIn("a", { x: 5, y: 0, w: 0, h: 0 }, { shift: false });
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b"]);
  });

  it("a diagram not yet on the page clears only itself", () => {
    const page = createPageSelection({ batch: (fn) => fn() });
    const a = fakeStore();
    const b = fakeStore();
    page.attach("b", b);
    b.select(["b1"]);
    const fa = page.facade("a", a);
    a.select(["a1"]);
    fa.clear();
    expect(a.getSnapshot().ids).toEqual([]);
    expect(b.getSnapshot().ids).toEqual(["b1"]);
  });
});

describe("the frame around a selection spanning diagrams", () => {
  // `b` sits 300px below `a` on screen, at twice its scale.
  const geometry = {
    bounds: (blockId: string) =>
      blockId === "a" ? { x: 10, y: 20, w: 100, h: 50, rot: 30 } : { x: 0, y: 0, w: 40, h: 40, rot: 0 },
    toClient: (blockId: string, p: { x: number; y: number }) =>
      blockId === "a" ? p : { x: p.x * 2, y: p.y * 2 + 300 },
    toScene: (blockId: string, p: { x: number; y: number }) =>
      blockId === "a" ? p : { x: p.x / 2, y: (p.y - 300) / 2 },
  };

  it("is one diagram's own frame, rotation and all, while only it holds shapes", () => {
    const page = createPageSelection({ batch: (fn) => fn(), geometry });
    const a = fakeStore();
    page.attach("a", a);
    page.attach("b", fakeStore());
    a.select(["a1"]);
    expect(page.unionIn("a")).toEqual({ x: 10, y: 20, w: 100, h: 50, rot: 30 });
  });

  it("spans every part, in the asking diagram's px, square to it", () => {
    const page = createPageSelection({ batch: (fn) => fn(), geometry });
    const a = fakeStore();
    const b = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    page.selectIn("a", ["a1"], { keep: true });
    page.selectIn("b", ["b1"], { keep: true });
    const inA = page.unionIn("a")!;
    // b's 40px box is 80 screen px, from y 300.
    expect(inA.rot).toBe(0);
    expect(inA.y + inA.h).toBeCloseTo(380);
    expect(inA.x).toBeCloseTo(0);
    const inB = page.unionIn("b")!;
    expect(inB.y + inB.h).toBeCloseTo(40);
    expect(inB.w).toBeCloseTo(inA.w / 2);
  });
});

describe("page canvas hub", () => {
  const setup = () => {
    const hub = createPageCanvasHub({ batch: (fn) => fn() });
    const main = createPageCanvas({ pane: "main", pageId: "p1", tools: hub.tools, batch: hub.batch });
    const aside = createPageCanvas({ pane: "aside", pageId: "p2", tools: hub.tools, batch: hub.batch });
    hub.addPane(main);
    hub.addPane(aside);
    return { hub, main, aside };
  };

  it("names the focused diagram and its pane", () => {
    const { hub, main } = setup();
    const a = entry("a");
    main.register(a);
    a.api.selection.select(["a1"]);
    expect(hub.getSnapshot()).toEqual({ pane: "main", focused: { pageId: "p1", blockId: "a" } });
  });

  it("keeps the same snapshot across clicks inside the focused diagram", () => {
    const { hub, main } = setup();
    const a = entry("a");
    main.register(a);
    a.api.selection.select(["a1"]);
    const held = hub.getSnapshot();
    const listener = vi.fn();
    hub.subscribe(listener);
    a.api.selection.select(["a2"]);
    a.api.selection.select(["a1", "a2"]);
    expect(hub.getSnapshot()).toBe(held);
    expect(listener).not.toHaveBeenCalled();
  });

  it("a selection in one pane clears the other", () => {
    const { hub, main, aside } = setup();
    const a = entry("a");
    const b = entry("b");
    main.register(a);
    aside.register(b);
    a.api.selection.select(["a1"]);
    b.api.selection.select(["b1"]);
    expect(a.api.selection.getSnapshot().ids).toEqual([]);
    expect(hub.getSnapshot()).toEqual({ pane: "aside", focused: { pageId: "p2", blockId: "b" } });
  });

  it("clears every pane at once — what a frame claim does", () => {
    const { hub, main, aside } = setup();
    const a = entry("a");
    const b = entry("b");
    main.register(a);
    aside.register(b);
    main.selection.selectIn("a", ["a1"]);
    hub.clearAll();
    expect(hub.getSnapshot()).toEqual({ pane: null, focused: null });
    expect(b.api.selection.getSnapshot().ids).toEqual([]);
  });

  it("hands out each pane's controller", () => {
    const { hub, main, aside } = setup();
    expect(hub.pane("main")).toBe(main);
    expect(hub.pane("aside")).toBe(aside);
  });
});

describe("page canvas registry", () => {
  it("resolves a diagram registered after it was asked for", async () => {
    const hub = createPageCanvasHub({ batch: (fn) => fn() });
    const page = createPageCanvas({ pane: "main", pageId: "p", tools: hub.tools, batch: hub.batch });
    const later = page.whenRegistered("a");
    const a = entry("a");
    page.register(a);
    await expect(later).resolves.toBe(a);
  });

  it("gives up on one that never registers", async () => {
    vi.useFakeTimers();
    try {
      const hub = createPageCanvasHub({ batch: (fn) => fn() });
      const page = createPageCanvas({ pane: "main", pageId: "p", tools: hub.tools, batch: hub.batch });
      const never = page.whenRegistered("ghost", 100);
      vi.advanceTimersByTime(150);
      await expect(never).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unregistered diagram leaves the selection", () => {
    const hub = createPageCanvasHub({ batch: (fn) => fn() });
    const page = createPageCanvas({ pane: "main", pageId: "p", tools: hub.tools, batch: hub.batch });
    const a = entry("a");
    const off = page.register(a);
    a.api.selection.select(["a1"]);
    off();
    expect(page.get("a")).toBeUndefined();
    expect(page.selection.getSnapshot().focused).toBeNull();
  });
});

describe("one selection change, one undo step", () => {
  // The stores parse diagram HTML, and this environment has no DOM.
  (globalThis as { DOMParser?: unknown }).DOMParser = LinkedomParser;

  const band = (id: string) =>
    `<nt-diagram h="120"><nt-rect id="${id}1" x="10" y="10" w="40" h="40"></nt-rect>` +
    `<nt-rect id="${id}2" x="80" y="10" w="40" h="40"></nt-rect></nt-diagram>`;

  /** Two real diagrams on one page, each its own domain on the spine, as the workspace wires them. */
  function wired() {
    const spine = new WorkspaceHistory();
    const page = createPageSelection({ batch: spine.batch, quiet: spine.walking });
    const diagram = (id: string) => {
      const store = new SceneStore(band(id));
      const raw = createSelectionStore(laidOutScene(store.getScene()));
      raw.setHistory(store);
      store.onHistory((event) => {
        if (event.type === "push") spine.record(id, event.selectionOnly ? "focus" : "edit");
      });
      const step = (moved: boolean) => ({ consumed: moved ? 1 : 0, redoable: moved });
      spine.register(id, { undo: () => step(store.undo()), redo: () => step(store.redo()) });
      page.attach(id, raw);
      return { store, raw, facade: page.facade(id, raw) };
    };
    return { spine, a: diagram("a"), b: diagram("b") };
  }

  /** A shape selected in `a` and then moved, so the next selection there is a step of its own. */
  async function holding(a: ReturnType<typeof wired>["a"]) {
    a.facade.select(["a1"]);
    a.store.dispatch({ type: "move", ids: ["a1"], dx: 5, dy: 0 });
    await Promise.resolve();
  }

  // The store tells the page before it records, so a change reaching it
  // outside a batch left the page's reply — the others cleared — as a step of
  // its own, and one ⌘Z brought back nothing that had been let go.
  it("a select-all in one diagram and the selection it lets go elsewhere undo as one", async () => {
    const { spine, a, b } = wired();
    await holding(a);
    b.facade.selectAll();
    expect(a.raw.getSnapshot().ids).toEqual([]);
    expect(b.raw.getSnapshot().ids.length).toBeGreaterThan(0);
    await spine.undo();
    expect([a.raw.getSnapshot().ids, b.raw.getSnapshot().ids]).toEqual([["a1"], []]);
  });

  it("a Tab with nothing to move from lets nothing go", async () => {
    const { a, b } = wired();
    await holding(a);
    expect(b.facade.selectSibling("next")).toBe(false);
    expect(a.raw.getSnapshot().ids).toEqual(["a1"]);
  });
});
