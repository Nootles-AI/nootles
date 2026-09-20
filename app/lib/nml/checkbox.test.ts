import * as Y from "yjs";
import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  NML_YJS_ROOT,
  convertLegacyDocument,
  createNmlYDoc,
  decodeNmlDocument,
  normalizeDocument,
  parseCanonicalDocument,
  repairDocument,
  serializeDocument,
  validateDocument,
  type NmlDocument,
} from ".";
import { nmlToAnyBlocks } from "./model/projection";

const parseHtml = (html: string) =>
  new DOMParser().parseFromString(html, "text/html") as unknown as Document;

/** A day of the tracker the reporter asked for: a label and two boxes. */
const tracker = (checked: boolean): NmlDocument => ({
  schemaVersion: 1,
  documentId: "doc-check",
  blocks: [
    {
      id: "t1",
      type: "table",
      props: { headerRows: 1 },
      columns: [{ id: "c1" }, { id: "c2" }],
      rows: [
        {
          id: "r1",
          cells: [
            { id: "h1", content: [{ type: "text", text: "Day", marks: [] }] },
            { id: "h2", content: [{ type: "text", text: "Water", marks: [] }] },
          ],
        },
        {
          id: "r2",
          cells: [
            { id: "d1", content: [{ type: "text", text: "1", marks: [] }] },
            { id: "d2", content: [{ type: "checkbox", id: "box-1", checked }] },
          ],
        },
      ],
      children: [],
    },
  ],
});

/**
 * The tick box in the canonical NML layer (NT-41).
 *
 * A box in a table cell is the whole point of the feature, so what matters here
 * is that a cell carrying one survives every hop a served document makes: the
 * canonical text form, the Yjs encoding, and the BlockNote compatibility mirror
 * in both directions. A box dropped on any of those hops is silent data loss.
 */
describe("the tick box in canonical NML", () => {
  it("is valid, and its state is not an optional field", () => {
    expect(validateDocument(tracker(true)).filter((i) => i.severity === "error")).toEqual([]);
    const missing = structuredClone(tracker(true)) as unknown as {
      blocks: Array<{ rows: Array<{ cells: Array<{ content: Array<Record<string, unknown>> }> }> }>;
    };
    delete missing.blocks[0].rows[1].cells[1].content[0].checked;
    expect(validateDocument(missing as unknown as NmlDocument).some((i) => i.severity === "error")).toBe(true);
  });

  it("round-trips through the canonical text form, ticked and unticked", () => {
    for (const checked of [true, false]) {
      const canonical = serializeDocument(tracker(checked));
      expect(canonical).toContain(`<nt-check id="box-1" checked="${checked}"></nt-check>`);
      // `parseCanonicalDocument` throws on any error diagnostic, so reaching
      // the equality below is itself the "parsed cleanly" assertion.
      expect(parseCanonicalDocument(canonical, { parseHtml })).toEqual(
        normalizeDocument(tracker(checked)),
      );
    }
  });

  it("round-trips through the Yjs encoding, and rejects a state that is neither true nor false", () => {
    const doc = createNmlYDoc(tracker(true));
    expect(decodeNmlDocument(doc)).toEqual(normalizeDocument(tracker(true)));

    // The decoder is strict by design: a box has two states and no third.
    const root = doc.getMap(NML_YJS_ROOT);
    const blocks = root.get("blocks") as Y.Array<Y.Map<unknown>>;
    const rows = blocks.get(0).get("rows") as Y.Array<Y.Map<unknown>>;
    const cells = rows.get(1).get("cells") as Y.Array<Y.Map<unknown>>;
    const content = cells.get(1).get("content") as Y.XmlFragment;
    (content.get(0) as Y.XmlElement).setAttribute("checked", "yes");
    expect(() => decodeNmlDocument(doc)).toThrow(/checked/);
  });

  it("survives the BlockNote mirror in both directions", () => {
    const legacy = nmlToAnyBlocks(tracker(true));
    const cell = (legacy[0] as { content: { rows: Array<{ cells: Array<{ content: unknown[] }> }> } })
      .content.rows[1].cells[1];
    // The editor's own inline content, which is what makes the box interactive.
    expect(cell.content).toEqual([{ type: "checkbox", props: { checked: true } }]);

    let minted = 0;
    const back = convertLegacyDocument(
      { documentId: "doc-check", blocks: legacy as never },
      { createId: () => `minted-${++minted}`, parseHtml },
    );
    expect(back.diagnostics.filter((i) => i.severity === "error")).toEqual([]);
    const row = (back.document.blocks[0] as { rows: Array<{ cells: Array<{ content: unknown[] }> }> }).rows[1];
    expect(row.cells[1].content).toEqual([
      // BlockNote has no field for the NML-only ID, so the converter mints one.
      { type: "checkbox", id: expect.any(String), checked: true },
    ]);
  });

  it("repairs a duplicate box ID inside a table cell", () => {
    // Reached only now that a cell can hold an inline entity at all. Left
    // unclaimed, two boxes sharing an ID are one box to the mirror.
    const clashing = structuredClone(tracker(false));
    const cells = (clashing.blocks[0] as { rows: Array<{ cells: Array<{ content: unknown[] }> }> }).rows[1].cells;
    cells[0].content = [{ type: "checkbox", id: "box-1", checked: true } as never];
    const repaired = repairDocument(clashing);
    expect(repaired.issues.map((i) => i.code)).toContain("duplicate_id_repaired");
    const fixed = (repaired.document as NmlDocument).blocks[0] as {
      rows: Array<{ cells: Array<{ content: Array<{ id: string }> }> }>;
    };
    const ids = [fixed.rows[1].cells[0].content[0].id, fixed.rows[1].cells[1].content[0].id];
    expect(new Set(ids).size).toBe(2);
  });
});
