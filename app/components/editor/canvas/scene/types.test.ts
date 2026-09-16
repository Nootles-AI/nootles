import { describe, expect, it } from "vitest";

import { SELECT_FIXTURE } from "../engine/useSelection.fixtures";
import { topSelection } from "./types";

/**
 * `topSelection` (SELECT §1.7): promoted verbatim from `engine/shortcuts.ts`
 * to live beside `selectedNodes`/`nodePath`, so `enterSelected()`
 * (`engine/useSelection.ts`) and `edit.vector`'s `targetIds()`
 * (`engine/shortcuts.ts`) can no longer disagree about what "exactly one
 * thing is addressed" means (review #5). This is the moved-verbatim
 * regression guard for the function's own output — `engine/shortcuts.ts`'s
 * existing behaviour (`targetIds` et al.) is unaffected by the move.
 */
describe("topSelection", () => {
  it("returns a single top-level node unchanged", () => {
    const top = topSelection(SELECT_FIXTURE, ["F"]);
    expect(top.map((n) => n.id)).toEqual(["F"]);
  });

  it("keeps two unrelated nodes, in document order", () => {
    const top = topSelection(SELECT_FIXTURE, ["P", "E"]);
    expect(top.map((n) => n.id)).toEqual(["E", "P"]);
  });

  it("dedupes an ancestor and its own descendant to just the ancestor", () => {
    // A (a leaf) is F's own descendant — addressing both would move/copy A twice.
    const top = topSelection(SELECT_FIXTURE, ["F", "A"]);
    expect(top.map((n) => n.id)).toEqual(["F"]);
  });

  it("dedupes a deeply-nested descendant the same way", () => {
    const top = topSelection(SELECT_FIXTURE, ["F", "K2"]);
    expect(top.map((n) => n.id)).toEqual(["F"]);
  });

  it("keeps a nested node when its own ancestor is not also selected", () => {
    const top = topSelection(SELECT_FIXTURE, ["B", "D"]);
    expect(top.map((n) => n.id)).toEqual(["B", "D"]);
  });

  it("drops ids no longer in the scene", () => {
    const top = topSelection(SELECT_FIXTURE, ["F", "does-not-exist"]);
    expect(top.map((n) => n.id)).toEqual(["F"]);
  });

  it("returns nothing for an empty selection", () => {
    expect(topSelection(SELECT_FIXTURE, [])).toEqual([]);
  });
});
