import { describe, expect, it } from "vitest";
import { SCRIPTS } from "./scripts";
import { resolveStep } from "./model";
import type { StageContext } from "./types";

/**
 * The seeded project as it actually exists on production: six pages, the
 * firmware source among them. Every firmware-reading call has to work here,
 * because this is what Ali will be sitting in front of — a bail in this
 * context is the demo's best call answering "I can't see the code" to a room.
 */
const seeded: StageContext = {
  projectId: "p1",
  pageId: "pg_open",
  said: "",
  results: [],
  pages: [
    { pageId: "pg_brief", title: "Program Brief" },
    { pageId: "pg_req", title: "Requirements & Traceability" },
    { pageId: "pg_test", title: "Test & Validation" },
    { pageId: "pg_icd", title: "ICD" },
    { pageId: "pg_fw", title: "Firmware source" },
    { pageId: "pg_notes", title: "Meeting notes — 2026-09-14" },
  ],
};

describe("reading the firmware from the project", () => {
  for (const id of ["C-16", "C-11"]) {
    it(`${id} runs every step and never bails`, () => {
      const script = SCRIPTS.find((s) => s.id === id)!;
      for (const [at, step] of script.steps.entries()) {
        const resolved = resolveStep(step, seeded, script.bail);
        expect(resolved.say, `${id} step ${at} bailed`).not.toBe(script.bail);
        expect(
          resolved.calls.length > 0 || !!resolved.say,
          `${id} step ${at} would end the turn silently`,
        ).toBe(true);
      }
    });

    it(`${id} reads the firmware source that is actually there`, () => {
      const script = SCRIPTS.find((s) => s.id === id)!;
      const reads = script.steps.flatMap((step) =>
        resolveStep(step, seeded, script.bail).calls.map((c) => c.input),
      );
      expect(JSON.stringify(reads), `${id} never read the firmware page`).toContain("pg_fw");
    });
  }

  it("no staged call can end a turn with nothing said and nothing done", () => {
    // The trap `optional` opens: if every call in a step stands down and the
    // step has no prose, the stream finishes and whatever came next is lost.
    const empty: StageContext = { ...seeded, pages: [], pageId: undefined };
    for (const script of SCRIPTS) {
      for (const [at, step] of script.steps.entries()) {
        const resolved = resolveStep(step, empty, script.bail);
        expect(
          resolved.calls.length > 0 || !!resolved.say,
          `${script.id} step ${at} vanishes when the project is bare`,
        ).toBe(true);
      }
    }
  });
});
