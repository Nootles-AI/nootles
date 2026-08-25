import { describe, expect, it } from "vitest";
import { ComputeEngine } from "@cortex-js/compute-engine";
import { evaluateLines } from "./engine";

const values = (lines: string[]) =>
  evaluateLines(ComputeEngine, lines).map((r) => r.valueLatex ?? r.error);

/**
 * The engine and the parsed lines are shared between evaluations, which is what
 * makes typing in a long sheet affordable — and what these guard: a value is
 * always the current one, whatever an earlier evaluation assigned.
 */
describe("evaluateLines", () => {
  it("resolves a variable used before it is defined", () => {
    expect(values(["b = a + 1", "a = 3"])).toEqual(["4", null]);
  });

  it("re-evaluates a reused line against the new assignment", () => {
    expect(values(["a = 3", "b = a + 1"])).toEqual([null, "4"]);
    expect(values(["a = 10", "b = a + 1"])).toEqual([null, "11"]);
  });

  it("forgets an assignment the sheet no longer makes", () => {
    expect(values(["a = 3", "a + 1"])).toEqual([null, "4"]);
    expect(values(["a + 1"])).toEqual(["undefined"]);
  });

  it("flags a circular reference rather than looping", () => {
    expect(values(["a = b + 1", "b = a + 1"])).toEqual([
      "circular reference",
      "circular reference",
    ]);
  });

  it("leaves a blank line empty", () => {
    const results = evaluateLines(ComputeEngine, ["", "2 + 2"]);
    expect(results[0].empty).toBe(true);
    expect(results[1].valueLatex).toBe("4");
  });
});
