import { describe, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { compileDocHtml } from "@/app/lib/ai/html/compile";
import { parseBatch } from "@/convex/ai/operations";
import { SCRIPTS } from "./scripts";
import type { StageContext } from "./types";

/**
 * Every canned payload, through the path `edit_page` actually takes.
 *
 * `parseDocHtml` proves the markup is a document; this proves the document
 * becomes operations, and that those operations survive the same Zod the
 * applier validates against. It is the last statically checkable link before
 * the browser: HTML → nodes → batch → validated.
 *
 * Without it a payload could parse perfectly and still compile to an empty
 * batch — "nothing to do" — which on stage is a call that visibly does
 * nothing at all.
 */

/**
 * The canvas parser reaches for a `DOMParser` global of its own, which
 * edge-runtime does not have — injecting one into `parseDocHtml` covers the
 * document parser and not the scene parser underneath it.
 */
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const parseHtml = (html: string) =>
  new DOMParser().parseFromString(html, "text/html") as unknown as Document;

/** A page with a couple of blocks, so a rewrite has somewhere to anchor. */
const CURRENT = parseDocHtml(
  '<h1 id="b1">ICD</h1><p id="b2">Interface control between compute and the motor controllers.</p>',
  parseHtml,
);

const ctx: StageContext = {
  projectId: "p1",
  pageId: "pg_open",
  said: "",
  results: [],
  pages: [
    { pageId: "pg_open", title: "ICD" },
    { pageId: "pg_req", title: "Requirements & Traceability" },
    { pageId: "pg_test", title: "Test & Validation" },
  ],
  repos: ["team-kestrel/kr1-firmware"],
};

function payloads(): { id: string; at: number; html: string }[] {
  const out: { id: string; at: number; html: string }[] = [];
  for (const script of SCRIPTS) {
    for (const [at, step] of script.steps.entries()) {
      for (const call of step.call ?? []) {
        if (call.tool !== "edit_page") continue;
        const input =
          typeof call.input === "function"
            ? (call.input as (c: StageContext) => { html?: string } | null)(ctx)
            : (call.input as { html?: string });
        if (input?.html) out.push({ id: script.id, at, html: input.html });
      }
    }
  }
  return out;
}

describe("every canned payload compiles to operations", () => {
  const all = payloads();

  it("there are payloads to compile", () => {
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  for (const { id, at, html } of all) {
    it(`${id} step ${at} produces a valid, non-empty batch`, () => {
      const next = parseDocHtml(html, parseHtml);
      const batch = compileDocHtml(next, { current: CURRENT, anchorBlockId: "b2" });

      // An empty batch is the quiet failure: the call runs, the chip flashes,
      // and the page does not change.
      expect(batch.ops.length, `${id} compiled to nothing`).toBeGreaterThan(0);

      // The same validator the applier runs before touching the document.
      const parsed = parseBatch(batch);
      expect(parsed.success, `${id}: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`).toBe(
        true,
      );
    });
  }

  it("the diagrams arrive as canvas blocks, not as markup in a paragraph", () => {
    // A canvas that compiled to a paragraph of angle brackets is the most
    // embarrassing possible outcome and would pass every other assertion.
    const withCanvas = all.filter((p) => /<nt-diagram/i.test(p.html));
    expect(withCanvas.length).toBeGreaterThanOrEqual(5);

    for (const { id, html } of withCanvas) {
      const batch = compileDocHtml(parseDocHtml(html, parseHtml), {
        current: CURRENT,
        anchorBlockId: "b2",
      });
      const inserted = batch.ops.flatMap((op) =>
        op.kind === "insertBlocks" ? op.blocks : [],
      );
      const kinds = new Set(inserted.map((b) => b.type));
      expect(kinds, `${id} produced no canvas block`).toContain("canvas");
    }
  });
});
