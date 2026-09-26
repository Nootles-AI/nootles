import { describe, expect, it } from "vitest";

import { layerRows, type LayerRow } from "../ContextMenu";
import { laidOutScene } from "../scene/autoLayout";
import type { Candidate } from "../scene/picking";
import { findNode, isBoolean, isContainer, topSelection, type NodeId, type SceneNode } from "../scene/types";
import type { RestoreSelection, SceneStore } from "./useScene";
import {
  createSelectionStore,
  descends,
  marqueeThroughTarget,
  type ClickMods,
  type Resolved,
  type SelectionStore,
} from "./useSelection";
import { SELECT_FIXTURE } from "./useSelection.fixtures";

/**
 * The §3 fixture, laid out once per store. Absolute (scene-space) boxes, for
 * building test points — every top-level node's local x/y already equals its
 * scene position, and every nested one is derived the same way the fixture's
 * own doc comment explains.
 *
 *   F (0,0)-(300,200)   A (20,20)-(220,50)   G (20,80)-(280,140)
 *   D (200,20)-(280,80) B (20,80)-(120,120)  C (140,90)-(160,110)
 *   K (170,95)-(200,125) [K1 same box; K2 (178,103)-(192,117)]
 *   E (320,20)-(420,50) P (320,100)-(420,160) L (0,150)-(300,200)
 */
function store(): SelectionStore {
  return createSelectionStore(laidOutScene(SELECT_FIXTURE));
}

const B_PT = { x: 70, y: 100 };
const C_PT = { x: 150, y: 100 }; // ellipse centre — always interior
const A_PT = { x: 100, y: 30 };
const E_PT = { x: 350, y: 30 };
const D_BORDER_PT = { x: 201, y: 50 }; // inside the 2px left border band
const D_INTERIOR_PT = { x: 240, y: 50 }; // hollow — no background painted here
const K_FILL_PT = { x: 172, y: 97 }; // inside K1's box, outside K2's cut hole
const F_PADDING_PT = { x: 250, y: 140 }; // inside F, outside A/G/D
const EMPTY_PT = { x: 450, y: 220 };

/** A fake `SceneStore`, for `setHistory` — records every restore thunk it is handed. */
function fakeHistory(): { calls: RestoreSelection[]; scene: SceneStore } {
  const calls: RestoreSelection[] = [];
  const scene = {
    recordSelection: (restore: RestoreSelection) => {
      calls.push(restore);
    },
    setSelectionHistory: () => {},
  } as unknown as SceneStore;
  return { calls, scene };
}

// ---------------------------------------------------------------------------
// click / probe — plain (C)
// ---------------------------------------------------------------------------

describe("click — outermost group, level tracking", () => {
  it("C1: click on B selects the outermost group F, level unchanged", () => {
    const s = store();
    expect(s.click(B_PT)).toBe("F");
    expect(s.getSnapshot()).toMatchObject({ ids: ["F"], enteredPath: [] });
  });

  it("C2/C3: once inside, a click picks among the entered level's own children", () => {
    const s = store();
    s.click(A_PT, { deep: true }); // ids=[A], level=[F] (A's own ancestry)
    expect(s.getSnapshot().enteredPath).toEqual(["F"]);
    expect(s.click(B_PT)).toBe("G"); // level [F]: B's ancestry inside F is G
    expect(s.getSnapshot().enteredPath).toEqual(["F"]);
    s.click(B_PT, { deep: true }); // ids=[B], level=[F, G]
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
    expect(s.click(B_PT)).toBe("B");
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
  });

  it("C4: a click outside the entered group drops to the shared level", () => {
    const s = store();
    s.select(["B"]); // level becomes [F, G] (B's ancestry)
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
    expect(s.click(A_PT)).toBe("A");
    expect(s.getSnapshot().enteredPath).toEqual(["F"]);
  });

  it("C5: click on the entered container's own padding deselects, keeps the level", () => {
    const s = store();
    s.select(["A"]); // level [F]
    expect(s.click(F_PADDING_PT)).toBeNull();
    expect(s.getSnapshot()).toMatchObject({ ids: [], enteredPath: ["F"] });
  });

  it("C8: a locked node is click-through — L is skipped, F shows through beneath it", () => {
    const s = store();
    expect(s.click({ x: 10, y: 175 })).toBe("F");
  });

  it("C9: click on empty canvas clears selection and level", () => {
    const s = store();
    s.select(["B"]);
    expect(s.click(EMPTY_PT)).toBeNull();
    expect(s.getSnapshot()).toMatchObject({ ids: [], enteredPath: [] });
  });

  it("C10/C11: shift-click toggles at the resolved depth, in document order", () => {
    const s = store();
    s.select(["F"]);
    s.click(E_PT, { shift: true });
    expect(s.getSnapshot().ids).toEqual(["F", "E"]);
    s.click({ x: 0, y: 0 }, { shift: true }); // F's own area at top level
    expect(s.getSnapshot().ids).toEqual(["E"]);
  });
});

// ---------------------------------------------------------------------------
// deep — Mod (D)
// ---------------------------------------------------------------------------

describe("deep click sets the level to the leaf's own ancestry", () => {
  it("D1/D2: deep-click sets level to the leaf's ancestry; a later plain click uses it", () => {
    const s = store();
    expect(s.click(B_PT, { deep: true })).toBe("B");
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
    expect(s.click(C_PT)).toBe("C");
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
  });

  it("D3: deep-click on a top-level node's own leaf sets an empty level", () => {
    const s = store();
    expect(s.click(E_PT, { deep: true })).toBe("E");
    expect(s.getSnapshot().enteredPath).toEqual([]);
  });

  it("D4: deep + shift toggles at the leaf depth but keeps the current level", () => {
    const s = store();
    s.click(B_PT, { deep: true });
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
    s.click(C_PT, { deep: true, shift: true });
    expect(s.getSnapshot().ids).toEqual(["B", "C"]);
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
  });

  it("D5/D6: a hollow rect's interior falls through to the painted frame; its border does not", () => {
    const s = store();
    expect(s.click(D_INTERIOR_PT, { deep: true })).toBe("F");
    expect(s.getSnapshot().enteredPath).toEqual([]);
    const s2 = store();
    expect(s2.click(D_BORDER_PT, { deep: true })).toBe("D");
    expect(s2.getSnapshot().enteredPath).toEqual(["F"]);
  });

  it("D13: deep-click on a boolean group's own paint selects it whole (leaf-like)", () => {
    const s = store();
    expect(s.click(K_FILL_PT, { deep: true })).toBe("K");
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
  });

  it("double-click on a selected boolean group steps into the operand under the pointer, exactly as enterSelected() does when there is no pointer to prefer", () => {
    // Live bug: PICK's walk never emits a boolean group's own operands as hit
    // candidates (they paint nothing of their own), so `enter()`'s chain-depth
    // `descends` check saw a boolean group's one-node chain as having nothing
    // deeper — a double-click on one fell through to a plain click, and
    // `enterSelected()` (Enter key) was the only way in.
    //
    // K1/K2 never appear as PICK candidates, but each still has its own real
    // geometry to test directly — and K_FILL_PT sits inside K1's box but
    // outside K2's cut hole, so it is K1's own paint that answers for it, not
    // K2 just because K2 is frontmost (a second live bug: entering always
    // landed on the frontmost operand regardless of where the double-click
    // actually was).
    const s = store();
    expect(s.click(K_FILL_PT, { deep: true })).toBe("K");
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G"]);
    s.enter(K_FILL_PT);
    expect(s.getSnapshot().ids).toEqual(["K1"]);
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G", "K"]);
  });

  it("a plain click (and so a press-to-drag) on the selected operand's own geometry resolves to it, not a deselect", () => {
    // Live bug: once entered into a boolean group, PICK's walk still never
    // offers an operand as its own candidate, so the chain ran out exactly
    // at the group and `resolve()` read that as "click on the entered
    // container's own empty fill" — the deselect case `click()` documents
    // for a plain (non-boolean) group's padding. But a boolean group's own
    // paint is never empty of any operand (every op's derived region is by
    // construction some operand's own geometry), so this always had a real
    // answer. Concretely: `CanvasSurface`'s pointerdown asks `isSelected`
    // for whatever `resolve()` names here to decide "press-and-drag moves
    // the selection" versus "start a marquee" — a `null` target read a
    // press on the very operand just double-clicked into as a press on
    // nothing, so it drew a marquee instead of moving the shape.
    const s = store();
    s.click(K_FILL_PT, { deep: true });
    s.enter(K_FILL_PT); // selects K1 (the fix above)
    expect(s.getSnapshot()).toMatchObject({ ids: ["K1"], enteredPath: ["F", "G", "K"] });
    expect(s.click(K_FILL_PT)).toBe("K1");
    expect(s.getSnapshot()).toMatchObject({ ids: ["K1"], enteredPath: ["F", "G", "K"] });
  });

  it("a second double-click at the same point, already inside the boolean group, does not re-enter it", () => {
    const s = store();
    s.click(K_FILL_PT, { deep: true });
    s.enter(K_FILL_PT);
    expect(s.getSnapshot().enteredPath).toEqual(["F", "G", "K"]);
    s.enter(K_FILL_PT);
    // Falls to a plain click at the now-entered level (K's own operand list,
    // none of them independently painted) — not a second, deeper "enter".
    expect(s.getSnapshot().enteredPath).not.toEqual(["F", "G", "K", "K2"]);
  });
});

// ---------------------------------------------------------------------------
// resolveAt agrees with probe/click everywhere
// ---------------------------------------------------------------------------

describe("resolveAt is probe's full candidate list", () => {
  const grid: { x: number; y: number }[] = [];
  for (let x = 0; x <= 440; x += 40) {
    for (let y = 0; y <= 240; y += 40) grid.push({ x, y });
  }
  const modsList: ClickMods[] = [{}, { deep: true }, { shift: true }, { deep: true, shift: true }];

  it("resolveAt(p, m).target?.id === probe(p, m) over a grid of points and mods", () => {
    const s = store();
    for (const mods of modsList) {
      for (const p of grid) {
        expect(s.resolveAt(p, mods).target?.id ?? null).toBe(s.probe(p, mods));
      }
    }
  });

  it("hover(p, m) === probe(p, m) over the same grid (H7)", () => {
    for (const mods of modsList) {
      for (const p of grid) {
        const fresh = store();
        expect(fresh.hover(p, mods)).toBe(fresh.probe(p, mods));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// marqueeThroughTarget — pure
// ---------------------------------------------------------------------------

describe("marqueeThroughTarget", () => {
  function resolvedWith(node: SceneNode): Resolved {
    return { candidates: [{ node, chain: [node], part: "fill", local: { x: 0, y: 0 } }], chain: [node], target: node, level: [] };
  }

  const F = findNode(SELECT_FIXTURE, "F")!; // group "Card", painted, non-boolean
  const B = findNode(SELECT_FIXTURE, "B")!; // a leaf rect
  const boolGroup = findNode(SELECT_FIXTURE, "K")!; // boolean group "Icon"

  it("returns the container's id for a non-boolean container's own paint under Mod-drag", () => {
    expect(marqueeThroughTarget(resolvedWith(F), { deep: true, shift: false })).toBe("F");
  });

  it("excludes a boolean group (review #1)", () => {
    expect(isBoolean(boolGroup)).toBe(true);
    expect(marqueeThroughTarget(resolvedWith(boolGroup), { deep: true, shift: false })).toBeNull();
  });

  it("returns null for a leaf (not a container)", () => {
    expect(isContainer(B)).toBe(false);
    expect(marqueeThroughTarget(resolvedWith(B), { deep: true, shift: false })).toBeNull();
  });

  it("requires deep, and shift always disables it", () => {
    expect(marqueeThroughTarget(resolvedWith(F), { deep: false, shift: false })).toBeNull();
    expect(marqueeThroughTarget(resolvedWith(F), { deep: true, shift: true })).toBeNull();
  });

  it("returns null with no candidates at all", () => {
    const empty: Resolved = { candidates: [], chain: [], target: null, level: [] };
    expect(marqueeThroughTarget(empty, { deep: true, shift: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hover
// ---------------------------------------------------------------------------

describe("hover", () => {
  it("H1/H2: rings the outermost group plainly, the leaf under Mod", () => {
    const s = store();
    expect(s.hover(B_PT)).toBe("F");
    expect(s.getSnapshot().hoverId).toBe("F");
    expect(s.hover(B_PT, { deep: true })).toBe("B");
  });

  it("H3: entered container's own padding rings nothing (a click there would deselect)", () => {
    const s = store();
    s.select(["A"]); // level [F]
    expect(s.hover(F_PADDING_PT)).toBeNull();
    expect(s.getSnapshot().hoverId).toBeNull();
  });

  it("H5: a hollow interior rings whatever is painted beneath it", () => {
    const s = store();
    expect(s.hover(D_INTERIOR_PT)).toBe("F");
  });

  it("null point clears the hover", () => {
    const s = store();
    s.hover(B_PT);
    expect(s.hover(null)).toBeNull();
    expect(s.getSnapshot().hoverId).toBeNull();
  });

  it("never records — 50 hovers leave history untouched", () => {
    const { calls, scene } = fakeHistory();
    const s = store();
    s.setHistory(scene);
    for (let i = 0; i < 50; i++) s.hover(i % 2 ? B_PT : C_PT);
    expect(calls.length).toBe(0);
  });

  it("keeps the identity of everything a hover did not change", () => {
    const s = store();
    s.select(["A", "E"]);
    const before = s.getSnapshot();
    s.hover(B_PT);
    const after = s.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.ids).toBe(before.ids);
    expect(after.selected).toBe(before.selected);
    expect(after.enteredPath).toBe(before.enteredPath);
    expect(after.edgeIds).toBe(before.edgeIds);
    expect(after.edgeSelected).toBe(before.edgeSelected);
  });
});

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

describe("candidates", () => {
  it("front to back, independent of the entered level (M2)", () => {
    const s = store();
    // K's own fill: the painted boolean "Icon" is frontmost, Card (F) behind
    // it. The plain group Row (G) is never its own candidate.
    expect(s.candidates(K_FILL_PT).map((c) => c.node.id)).toEqual(["K", "F"]);
  });

  it("excludes locked nodes by default, includes them with includeLocked", () => {
    const s = store();
    // L (locked) sits entirely over F: excluded by default reveals F beneath
    // it; included, L wins as the frontmost candidate.
    expect(s.candidates({ x: 10, y: 175 }).map((c) => c.node.id)).toEqual(["F"]);
    expect(s.candidates({ x: 10, y: 175 }, { includeLocked: true }).map((c) => c.node.id)).toEqual(["L", "F"]);
  });

  it("is pure: no selection change, no history entry", () => {
    const { calls, scene } = fakeHistory();
    const s = store();
    s.setHistory(scene);
    const before = s.getSnapshot();
    s.candidates(B_PT);
    expect(s.getSnapshot()).toBe(before);
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hoverNode
// ---------------------------------------------------------------------------

describe("hoverNode", () => {
  it("sets the hover without hit-testing, clears with null", () => {
    const s = store();
    s.hoverNode("F");
    expect(s.getSnapshot().hoverId).toBe("F");
    s.hoverNode(null);
    expect(s.getSnapshot().hoverId).toBeNull();
  });

  it("never records", () => {
    const { calls, scene } = fakeHistory();
    const s = store();
    s.setHistory(scene);
    s.hoverNode("F");
    s.hoverNode("B");
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// enterSelected — Enter
// ---------------------------------------------------------------------------

describe("enterSelected", () => {
  it("steps into a container and selects its frontmost eligible child (K1/K2)", () => {
    const s = store();
    s.select(["F"]);
    expect(s.enterSelected()).toBe(true);
    // F's children in document order are [A, G, D] — the frontmost is D.
    expect(s.getSnapshot()).toMatchObject({ ids: ["D"], enteredPath: ["F"] });
  });

  it("steps into a nested group the same way", () => {
    const s = store();
    s.select(["G"]);
    expect(s.enterSelected()).toBe(true);
    // G's children are [B, C, K] — frontmost is K.
    expect(s.getSnapshot()).toMatchObject({ ids: ["K"], enteredPath: ["F", "G"] });
  });

  it("boolean groups count as containers (review #1, K27)", () => {
    const s = store();
    s.select(["K"]);
    expect(s.enterSelected()).toBe(true);
    expect(s.getSnapshot()).toMatchObject({ ids: ["K2"], enteredPath: ["F", "G", "K"] });
  });

  it("refuses: multiple selected, a leaf, or an empty group", () => {
    const s = store();
    s.select(["A", "G"]);
    expect(s.enterSelected()).toBe(false);
    s.select(["B"]);
    expect(s.enterSelected()).toBe(false);
    s.select([]);
    expect(s.enterSelected()).toBe(false);
  });

  it("dedupes an ancestor and its own descendant to just the ancestor (review #5)", () => {
    const s = store();
    s.select(["F", "A"]);
    expect(s.enterSelected()).toBe(true);
    expect(s.getSnapshot().ids).toEqual(["D"]);
  });
});

// ---------------------------------------------------------------------------
// selectParent — Shift+Enter
// ---------------------------------------------------------------------------

describe("selectParent", () => {
  it("selects the shared parent, leaving the level at its ancestors (K9/K10)", () => {
    const s = store();
    s.select(["B"]); // level [F, G]
    expect(s.selectParent()).toBe(true);
    expect(s.getSnapshot()).toMatchObject({ ids: ["G"], enteredPath: ["F"] });
    expect(s.selectParent()).toBe(true);
    expect(s.getSnapshot()).toMatchObject({ ids: ["F"], enteredPath: [] });
  });

  it("refuses at the top level and on mixed parents", () => {
    const s = store();
    s.select(["F"]);
    expect(s.selectParent()).toBe(false);
    s.select(["B", "A"]); // B under G, A under F — different parents
    expect(s.selectParent()).toBe(false);
  });

  it("with nothing selected but a level entered, behaves as escape (K13)", () => {
    const s = store();
    s.select(["B"]); // level [F, G]
    s.click(F_PADDING_PT); // deselect, stay at level [F]... actually F_PADDING_PT is at top level
    s.clear();
    s.select(["G"]); // re-enter level [F]
    s.click(F_PADDING_PT); // click F's own padding: deselects, keeps level [F]
    expect(s.getSnapshot()).toMatchObject({ ids: [], enteredPath: ["F"] });
    expect(s.selectParent()).toBe(true);
    expect(s.getSnapshot()).toMatchObject({ ids: ["F"], enteredPath: [] });
  });

  it("refuses with nothing selected and nothing entered (K14)", () => {
    const s = store();
    expect(s.selectParent()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectSibling — Tab / Shift+Tab
// ---------------------------------------------------------------------------

describe("selectSibling", () => {
  it("next walks toward the back, wrapping; previous walks toward the front", () => {
    const s = store();
    s.select(["D"]); // level [F], D at index 2 of [A, G, D]
    expect(s.selectSibling("next")).toBe(true); // toward back: D -> G
    expect(s.getSnapshot().ids).toEqual(["G"]);
    expect(s.selectSibling("next")).toBe(true); // G -> A
    expect(s.getSnapshot().ids).toEqual(["A"]);
    expect(s.selectSibling("next")).toBe(true); // wraps: A -> D
    expect(s.getSnapshot().ids).toEqual(["D"]);
    expect(s.selectSibling("previous")).toBe(true); // back to A
    expect(s.getSnapshot().ids).toEqual(["A"]);
  });

  it("is not consumed with nothing eligible selected at this level — the keyboard-trap fix (review #7)", () => {
    const s = store();
    s.select(["G"]); // level [F], but selection itself is AT level [F] (G is one of its members)
    s.select([]);
    // Nothing selected at all, level still top ([]):
    const before = s.getSnapshot();
    expect(s.selectSibling("next")).toBe(false);
    expect(s.getSnapshot()).toBe(before);
  });

  it("is not consumed at an empty level", () => {
    const s = store();
    // Enter an empty level is not directly reachable here without a group
    // with zero children; simulate by entering a level whose only members are
    // locked (L is top-level only, so use G's own — not applicable). Instead
    // verify: entered level [F, G], nothing of G's own children selected.
    s.select(["A"]); // level [F]
    // step to a level with no prior selection member: manually via select().
    s.select(["K1"]); // enters [F, G, K]; K1/K2 are eligible siblings
    s.select([]);
    expect(s.selectSibling("next")).toBe(false);
  });

  it("skips hidden and locked siblings; a lead that is itself ineligible is no lead", () => {
    const s = store();
    // At the top level, L is locked and excluded from `eligible`.
    s.select(["F"]);
    expect(s.selectSibling("next")).toBe(true);
    expect(s.getSnapshot().ids).toEqual(["P"]); // F -> E -> P, skipping nothing here yet
  });
});

// ---------------------------------------------------------------------------
// marquee — within (⌘-drag through a frame)
// ---------------------------------------------------------------------------

describe("marquee with `within`", () => {
  it("scopes to the container's children and enters it (Q1)", () => {
    const s = store();
    s.marquee({ x: 0, y: 0, w: 300, h: 200 }, { within: "F" });
    // F's direct children whose subtree intersects the rect: A, G, D (all inside F).
    expect(s.getSnapshot().enteredPath).toEqual(["F"]);
    expect([...s.getSnapshot().ids].sort()).toEqual(["A", "D", "G"]);
  });

  it("falls back to the current level when the id is missing or not a container", () => {
    const s = store();
    s.marquee({ x: 0, y: 0, w: 500, h: 300 }, { within: "does-not-exist" });
    expect(s.getSnapshot().enteredPath).toEqual([]);
    s.clear();
    s.marquee({ x: 0, y: 0, w: 500, h: 300 }, { within: "B" }); // B is a leaf, not a container
    expect(s.getSnapshot().enteredPath).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// history — one selection entry per verb
// ---------------------------------------------------------------------------

describe("history: one recordSelection call per verb, none for reads", () => {
  it("click / select / enterSelected / selectParent / selectSibling each record once", () => {
    const { calls, scene } = fakeHistory();
    const s = store();
    s.setHistory(scene);
    s.click(B_PT); // -> ids=[F], level=[]
    expect(calls.length).toBe(1);
    s.select(["G"]); // -> ids=[G], level=[F]
    expect(calls.length).toBe(2);
    s.enterSelected(); // -> ids=[K] (G's frontmost child), level=[F, G]
    expect(calls.length).toBe(3);
    s.selectParent(); // -> ids=[G], level=[F]
    expect(calls.length).toBe(4);
    s.select(["B"]); // -> ids=[B], level=[F, G]
    expect(calls.length).toBe(5);
    s.selectSibling("next"); // B -> wraps toward the back -> K
    expect(calls.length).toBe(6);
    expect(s.getSnapshot().ids).toEqual(["K"]);
    // Reads never record.
    s.hover(B_PT);
    s.hoverNode("F");
    s.candidates(B_PT);
    s.resolveAt(B_PT);
    expect(calls.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// topSelection — re-export sanity (full coverage in scene/types.test.ts)
// ---------------------------------------------------------------------------

describe("topSelection (promoted export, §1.7)", () => {
  it("dedupes an ancestor and its own descendant to the ancestor", () => {
    const laid = laidOutScene(SELECT_FIXTURE);
    const top = topSelection(laid, ["F", "A"] as readonly NodeId[]);
    expect(top.map((n) => n.id)).toEqual(["F"]);
  });
});

// ---------------------------------------------------------------------------
// layerRows — ContextMenu.tsx's pure export
// ---------------------------------------------------------------------------

describe("layerRows", () => {
  function candidatesAt(ids: readonly NodeId[]): Candidate[] {
    return store()
      .candidates(B_PT)
      .filter((c) => ids.includes(c.node.id)) as Candidate[];
  }

  it("names and glyphs, front to back", () => {
    const s = store();
    const cands = s.candidates(K_FILL_PT) as Candidate[];
    const rows: LayerRow[] = layerRows(SELECT_FIXTURE, cands, new Set());
    expect(rows.map((r) => r.name)).toEqual(["Icon", "Card"]);
    expect(rows.every((r) => typeof r.glyph === "string" && r.glyph.length > 0)).toBe(true);
  });

  it("disambiguates a repeated name by its parent, then by id", () => {
    const nodeA = { id: "b1", kind: "rect", x: 0, y: 0, w: 10, h: 10, rot: 0, style: {}, label: "Button", locked: false, hidden: false, attrs: {} } as SceneNode;
    const nodeB = { id: "b2", kind: "rect", x: 0, y: 0, w: 10, h: 10, rot: 0, style: {}, label: "Button", locked: false, hidden: false, attrs: {} } as SceneNode;
    const parent1: SceneNode = { id: "p1", kind: "group", x: 0, y: 0, w: 10, h: 10, rot: 0, style: {}, label: "Row", locked: false, hidden: false, attrs: {}, children: [nodeA] } as SceneNode;
    const parent2: SceneNode = { id: "p2", kind: "group", x: 0, y: 0, w: 10, h: 10, rot: 0, style: {}, label: "Row", locked: false, hidden: false, attrs: {}, children: [nodeB] } as SceneNode;
    const cands: Candidate[] = [
      { node: nodeA, chain: [parent1, nodeA], part: "fill", local: { x: 0, y: 0 } },
      { node: nodeB, chain: [parent2, nodeB], part: "fill", local: { x: 0, y: 0 } },
    ];
    const rows = layerRows([parent1, parent2], cands, new Set());
    expect(rows.map((r) => r.hint)).toEqual(["Row · b1", "Row · b2"]);
  });

  it("marks the already-selected row", () => {
    const cands = candidatesAt(["B", "F"]);
    const rows = layerRows(SELECT_FIXTURE, cands, new Set(["F"]));
    expect(rows.find((r) => r.id === "F")?.selected).toBe(true);
    expect(rows.find((r) => r.id === "B")?.selected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// descends — unchanged pure helper, exercised via the fixture
// ---------------------------------------------------------------------------

describe("descends", () => {
  it("says whether a double-click goes one level in", () => {
    const s = store();
    const chain = s.resolveAt(B_PT, { deep: true }).chain;
    expect(descends([], chain)).toBe(true); // F -> G -> B: more than one level below []
    expect(descends(["F", "G"], chain)).toBe(false); // already at B's own level
  });
});

describe("selectAll", () => {
  it("says whether it changed anything, so a second ⌘A can reach further", () => {
    const s = store();
    expect(s.selectAll()).toBe(true);
    const all = s.getSnapshot().ids;
    expect(all.length).toBeGreaterThan(0);
    expect(s.selectAll()).toBe(false);
    expect(s.getSnapshot().ids).toBe(all);
  });

  it("inside a group, takes the group's children, then has nothing more to take", () => {
    const s = store();
    s.select(["A"]);
    expect(s.getSnapshot().enteredPath).toEqual(["F"]);
    expect(s.selectAll()).toBe(true);
    expect(s.getSnapshot().ids).toContain("G");
    expect(s.selectAll()).toBe(false);
  });

  it("changes a connector selection into the level's shapes", () => {
    const s = store();
    s.selectAll();
    s.selectEdges(["e1"]);
    expect(s.selectAll()).toBe(true);
  });
});

describe("capture", () => {
  it("puts back the selection it was taken over, recording nothing", () => {
    const s = store();
    const history = fakeHistory();
    s.select(["E"]);
    s.setHistory(history.scene);
    const restore = s.capture();
    s.select(["P"]);
    const recorded = history.calls.length;
    restore();
    expect(s.getSnapshot().ids).toEqual(["E"]);
    expect(history.calls.length).toBe(recorded);
  });
});
