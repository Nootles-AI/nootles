import { describe, expect, test } from "vitest";
import { coChange } from "./cochange";

describe("coChange", () => {
  test("a two-file commit is a whole unit; wider commits share theirs", () => {
    expect(coChange([["b", "a"]])).toEqual([{ a: "a", b: "b", weight: 1 }]);
    // Three files: each pair gets 1/2 — twice over reaches the threshold.
    expect(coChange([["a", "b", "c"]])).toEqual([]);
    expect(coChange([["a", "b", "c"], ["c", "b", "a"]])).toEqual([
      { a: "a", b: "b", weight: 1 },
      { a: "a", b: "c", weight: 1 },
      { a: "b", b: "c", weight: 1 },
    ]);
  });

  test("thirds sum to a whole despite floating point", () => {
    const commit = ["a", "b", "c", "d"];
    const pairs = coChange([commit, commit, commit]);
    expect(pairs).toHaveLength(6);
  });

  test("sweeping commits are ignored", () => {
    const sweep = Array.from({ length: 41 }, (_, i) => `f${i}`);
    expect(coChange([sweep, sweep, ["f0", "f1"]])).toEqual([{ a: "f0", b: "f1", weight: 1 }]);
    const forty = sweep.slice(0, 40);
    expect(coChange(Array(39).fill(forty)).length).toBe((40 * 39) / 2);
  });

  test("only known paths count, and duplicates within a commit collapse", () => {
    const known = new Set(["a", "b"]);
    expect(coChange([["a", "b", "lock.json"], ["a", "a", "b"]], known)).toEqual([
      { a: "a", b: "b", weight: 2 },
    ]);
  });

  test("sorted by pair", () => {
    const pairs = coChange([["z", "y"], ["b", "a"], ["m", "a"]]);
    expect(pairs.map((p) => `${p.a}-${p.b}`)).toEqual(["a-b", "a-m", "y-z"]);
  });
});
