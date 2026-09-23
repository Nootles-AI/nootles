import { describe, expect, it } from "vitest";
import { CARD_GAP, stackCards, type MarginItem } from "./marginLayout";

const item = (id: string, top: number, height = 50): MarginItem => ({ id, top, height });
const layout = (items: MarginItem[], focused: string | null = null, gap?: number) =>
  Object.fromEntries(stackCards(items, focused, gap));

/** No two cards overlap, and each keeps at least `gap` from the next. */
function expectClear(items: MarginItem[], tops: Map<string, number>, gap = CARD_GAP) {
  const boxes = items
    .map((i) => ({ id: i.id, top: tops.get(i.id)!, bottom: tops.get(i.id)! + Math.max(0, i.height) }))
    .sort((a, b) => a.top - b.top);
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].top - boxes[i - 1].bottom, `${boxes[i - 1].id} → ${boxes[i].id}`).toBeGreaterThanOrEqual(gap - 1e-9);
  }
}

describe("stackCards without a focused card", () => {
  it("leaves cards that fit where they want to be", () => {
    expect(layout([item("a", 0), item("b", 100), item("c", 300)])).toEqual({ a: 0, b: 100, c: 300 });
  });

  it("pushes an overlapping card down below the one above, a gap apart", () => {
    expect(layout([item("a", 0), item("b", 20)])).toEqual({ a: 0, b: 50 + CARD_GAP });
  });

  it("cascades: a pushed card pushes the next", () => {
    expect(layout([item("a", 0), item("b", 10), item("c", 20)], null, 10)).toEqual({ a: 0, b: 60, c: 120 });
  });

  it("stops cascading once a card's own place is lower", () => {
    expect(layout([item("a", 0), item("b", 10), item("c", 500)], null, 10)).toEqual({ a: 0, b: 60, c: 500 });
  });

  it("sorts by wanted top, whatever order the items came in", () => {
    expect(layout([item("c", 200), item("a", 0), item("b", 30)], null, 10)).toEqual({ a: 0, b: 60, c: 200 });
  });

  it("keeps the given order between cards that want the same place", () => {
    expect(layout([item("second", 40), item("first", 40)], null, 10)).toEqual({ second: 40, first: 100 });
  });

  it("treats a zero or negative height as a point that still keeps the gap", () => {
    expect(layout([item("a", 0, 0), item("b", 0, -5), item("c", 0, 10)], null, 4)).toEqual({ a: 0, b: 4, c: 8 });
  });

  it("returns nothing for nothing", () => {
    expect(stackCards([], null).size).toBe(0);
    expect(stackCards([], "x").size).toBe(0);
  });

  it("a focus naming no card is no focus", () => {
    expect(layout([item("a", 0), item("b", 20)], "gone", 10)).toEqual(layout([item("a", 0), item("b", 20)], null, 10));
  });
});

describe("stackCards with a focused card", () => {
  it("puts the focused card exactly where it wants to be", () => {
    const items = [item("a", 0), item("b", 10), item("c", 20)];
    expect(stackCards(items, "c", 10).get("c")).toBe(20);
    expect(stackCards(items, "b", 10).get("b")).toBe(10);
  });

  it("pushes the cards above it up, clear of it, in order", () => {
    expect(layout([item("a", 0), item("b", 10), item("c", 20)], "c", 10)).toEqual({ a: -100, b: -40, c: 20 });
  });

  it("pushes the cards below it down, clear of it", () => {
    expect(layout([item("a", 0), item("b", 10), item("c", 20)], "a", 10)).toEqual({ a: 0, b: 60, c: 120 });
  });

  it("moves the neighbours on both sides of a focused middle card", () => {
    expect(layout([item("a", 0), item("b", 10), item("c", 20)], "b", 10)).toEqual({ a: -50, b: 10, c: 70 });
  });

  it("leaves cards above alone when they already clear it", () => {
    expect(layout([item("a", 0), item("b", 100), item("c", 400)], "c", 10)).toEqual({ a: 0, b: 100, c: 400 });
  });

  it("stacks the cards above downward first, and pushes up only what the focused card needs", () => {
    // a and b overlap each other but are far above c: they stack as usual,
    // and c's focus does not drag a up past where it wants to be.
    expect(layout([item("a", 0, 100), item("b", 10), item("c", 500)], "c", 10)).toEqual({ a: 0, b: 110, c: 500 });
    // Now c is close enough that b must rise — and b rising pushes a too.
    expect(layout([item("a", 0, 100), item("b", 10), item("c", 150)], "c", 10)).toEqual({ a: -20, b: 90, c: 150 });
  });

  it("returns to the plain stack once nothing is focused", () => {
    const items = [item("a", 0), item("b", 10), item("c", 20)];
    expect(layout(items, "c", 10)).not.toEqual(layout(items, null, 10));
    expect(layout(items, null, 10)).toEqual({ a: 0, b: 60, c: 120 });
  });

  it("with a tie, focuses the named card and keeps the other on its side", () => {
    expect(layout([item("x", 40), item("y", 40)], "y", 10)).toEqual({ x: -20, y: 40 });
    expect(layout([item("x", 40), item("y", 40)], "x", 10)).toEqual({ x: 40, y: 100 });
  });
});

describe("stackCards at scale", () => {
  it("fifty cards on nearby lines never overlap, focused or not, and stay in anchor order", () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`t${i}`, i * 13, 40 + (i % 7) * 11));
    for (const focused of [null, "t0", "t17", "t49"]) {
      const tops = stackCards(items, focused);
      expect(tops.size).toBe(50);
      expectClear(items, tops);
      const order = [...items].sort((a, b) => tops.get(a.id)! - tops.get(b.id)!).map((i) => i.id);
      expect(order).toEqual(items.map((i) => i.id));
      if (focused) expect(tops.get(focused)).toBe(items.find((i) => i.id === focused)!.top);
    }
  });

  it("never pushes a card below its place when nothing is focused, nor above it", () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`t${i}`, (i * 37) % 400, 30 + (i % 5) * 9));
    const tops = stackCards(items, null);
    for (const i of items) expect(tops.get(i.id)!).toBeGreaterThanOrEqual(i.top);
    expectClear(items, tops);
  });

  it("is a pure function of its input", () => {
    const items = [item("a", 5), item("b", 6), item("c", 7)];
    const copy = items.map((i) => ({ ...i }));
    expect(layout(items, "b")).toEqual(layout(items, "b"));
    expect(items).toEqual(copy);
  });
});
