import { describe, expect, it, vi } from "vitest";
import type { SelectionStore } from "../engine/useSelection";
import type { CanvasApi } from "../render/CanvasSurface";
import { createPageSelection } from "./pageSelection";
import { createPageCanvas, createPageCanvasHub, type DiagramEntry } from "./PageCanvas";

/** Just enough of a selection store: ids, edges, and the hover that moves the snapshot too. */
function fakeStore() {
  let snap = { ids: [] as string[], edgeIds: [] as string[], hoverId: null as string | null };
  const listeners = new Set<() => void>();
  const write = (next: Partial<typeof snap>) => {
    snap = { ...snap, ...next };
    for (const l of listeners) l();
  };
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    getSnapshot: () => snap,
    isSelected: (id: string) => snap.ids.includes(id),
    select: (ids: readonly string[]) => write({ ids: [...ids], edgeIds: [] }),
    selectEdges: (edgeIds: readonly string[]) => write({ ids: [], edgeIds: [...edgeIds] }),
    clear: () => {
      if (snap.ids.length || snap.edgeIds.length) write({ ids: [], edgeIds: [] });
    },
    hover: (hoverId: string | null) => write({ hoverId }),
  } as unknown as SelectionStore & {
    selectEdges(ids: readonly string[]): void;
    hover(id: string | null): void;
  };
}

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
    page.select("a", ["a1"]);
    page.select("b", ["b1"], { additive: true });
    expect([...page.getSnapshot().parts.keys()]).toEqual(["b", "a"]);
    expect(page.getSnapshot().focused).toBe("b");
    page.select("a", ["a2"]);
    expect([...page.getSnapshot().parts.keys()]).toEqual(["a"]);
  });

  it("focus falls to the last diagram still holding a selection, then to nothing", () => {
    const page = plain();
    const a = fakeStore();
    const b = fakeStore();
    page.attach("a", a);
    page.attach("b", b);
    page.select("a", ["a1"]);
    page.select("b", ["b1"], { additive: true });
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
    page.select("a", ["a1"]);
    page.select("b", ["b1"], { additive: true });
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
  api: { selection, band: { current: null } } as unknown as CanvasApi,
  readOnly: false,
  flushMirror: () => {},
  remove: () => {},
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
    main.selection.select("a", ["a1"]);
    hub.clearAll();
    expect(hub.getSnapshot()).toEqual({ pane: null, focused: null });
    expect(b.api.selection.getSnapshot().ids).toEqual([]);
  });

  it("hands out the pane for a page", () => {
    const { hub, aside } = setup();
    expect(hub.forPage("p2")).toBe(aside);
    expect(hub.forPage("nope")).toBeNull();
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
