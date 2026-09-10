import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { canvasMapName, populateCanvas } from "@/app/components/editor/canvas/collab/ymap";
import {
  UNDERSTOOD_LEGACY_CODES,
  buildLegacyShadow,
  canvasSceneFromMaps,
  canvasSceneFromMirror,
  compareLegacyToNml,
  compareScenes,
  convertLegacyDocument,
  decodeNmlDocument,
  normalizeDocument,
  serializeDocument,
  type LegacyBlock,
  type LegacyDocumentInput,
  type NmlCanvasBlock,
  type NmlMathBlock,
  type NmlMediaBlock,
  type NmlTableBlock,
  type NmlTextBlock,
} from ".";

/** Deterministic ID minter so conversions are reproducible in tests. */
const counter = () => {
  let n = 0;
  return () => `mint-${n++}`;
};

const fixturesDir = fileURLToPath(new URL("./__fixtures__/legacy", import.meta.url));
const fixtureNames = readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));
const loadFixture = (name: string): LegacyDocumentInput =>
  JSON.parse(readFileSync(`${fixturesDir}/${name}`, "utf8")) as LegacyDocumentInput;

const errors = (diagnostics: { severity: string }[]) => diagnostics.filter((d) => d.severity === "error");

describe("legacy conversion", () => {
  it("has a golden conversion of a representative rich-text document", () => {
    const { document, diagnostics } = convertLegacyDocument(loadFixture("rich-text.json"), { createId: counter() });
    expect(errors(diagnostics)).toEqual([]);
    expect(serializeDocument(document)).toMatchSnapshot();
    expect(diagnostics.every((d) => UNDERSTOOD_LEGACY_CODES.has(d.code))).toBe(true);
  });

  it("preserves stable block IDs and mints only where BlockNote had none", () => {
    const { document, diagnostics } = convertLegacyDocument(loadFixture("rich-text.json"), { createId: counter() });
    const ids = document.blocks.map((b) => b.id);
    expect(ids).toContain("p1");
    expect(ids).toContain("h1");
    const paragraph = document.blocks[0] as NmlTextBlock;
    const math = paragraph.content.find((n) => n.type === "math");
    const ref = paragraph.content.find((n) => n.type === "pageRef");
    expect(math && math.type === "math" && math.id).toMatch(/^mint-/);
    expect(ref && ref.type === "pageRef" && ref.pageId).toBe("page-42");
    expect(diagnostics.filter((d) => d.code === "legacy_minted_id").length).toBeGreaterThan(0);
  });

  it("carries bold/italic/code/underline marks and links through unchanged", () => {
    const { document } = convertLegacyDocument(loadFixture("rich-text.json"), { createId: counter() });
    const paragraph = document.blocks[0] as NmlTextBlock;
    const boldItalic = paragraph.content.find((n) => n.type === "text" && n.text === "bold italic");
    expect(boldItalic && boldItalic.type === "text" && boldItalic.marks).toEqual(["bold", "italic"]);
    const link = paragraph.content.find((n) => n.type === "link");
    expect(link && link.type === "link" && link.href).toBe("https://nootles.ai");
  });

  it("mints stable IDs for every table column, row, and cell BlockNote stores positionally", () => {
    const { document } = convertLegacyDocument(loadFixture("table.json"), { createId: counter() });
    const table = document.blocks[0] as NmlTableBlock;
    expect(table.props.headerRows).toBe(1);
    expect(table.columns).toHaveLength(2);
    expect(table.columns.every((c) => c.id.length > 0)).toBe(true);
    expect(table.rows).toHaveLength(3);
    expect(table.rows.every((r) => r.id.length > 0 && r.cells.length === 2 && r.cells.every((c) => c.id.length > 0))).toBe(true);
    // The third row used the bare-run-list cell shape rather than the tableCell wrapper.
    const beta = table.rows[2].cells[0].content[0];
    expect(beta.type === "text" && beta.text).toBe("Beta");
  });

  it("splits a math block's newline-joined source into addressable rows", () => {
    const { document } = convertLegacyDocument(loadFixture("code-math.json"), { createId: counter() });
    const math = document.blocks[1] as NmlMathBlock;
    expect(math.rows.map((r) => r.latex)).toEqual(["a + b", "c < d"]);
    const empty = document.blocks[2] as NmlMathBlock;
    expect(empty.rows).toEqual([]);
  });

  it("maps media URLs to a url source and drops empty sources", () => {
    const { document } = convertLegacyDocument(loadFixture("media.json"), { createId: counter() });
    const image = document.blocks[0] as NmlMediaBlock;
    expect(image.props.source).toEqual({ kind: "url", url: "https://example.com/pic.png" });
    expect(image.props.caption).toBe("A picture");
    const emptyImage = document.blocks[4] as NmlMediaBlock;
    expect(emptyImage.props.source).toBeUndefined();
  });

  it("omits blocks NML v1 cannot represent and hoists their children rather than dropping them", () => {
    const { document, diagnostics } = convertLegacyDocument(loadFixture("edge-cases.json"), { createId: counter() });
    expect(document.blocks.some((b) => b.id === "stub1")).toBe(false);
    expect(document.blocks.map((b) => b.id)).toContain("stub-child");
    expect(document.blocks.map((b) => b.id)).toContain("para-child");
    expect(diagnostics.some((d) => d.code === "legacy_unsupported_block")).toBe(true);
    expect(diagnostics.some((d) => d.code === "legacy_flattened_children")).toBe(true);
    const ws = document.blocks.find((b) => b.id === "ws") as NmlTextBlock;
    expect(ws.content[0].type === "text" && ws.content[0].text).toBe("collapse these spaces");
  });
});

describe("shadow NML", () => {
  it("builds a non-serving Y.Doc that decodes back to the converted document", () => {
    const shadow = buildLegacyShadow(loadFixture("canvas-html.json"), { createId: counter() });
    expect(shadow.doc).not.toBeNull();
    expect(decodeNmlDocument(shadow.doc!)).toEqual(shadow.document);
  });

  it("round-trips every fixture through the shadow encoding", () => {
    for (const name of fixtureNames) {
      const shadow = buildLegacyShadow(loadFixture(name), { createId: counter() });
      expect(errors(shadow.diagnostics), name).toEqual([]);
      expect(shadow.doc, name).not.toBeNull();
      expect(decodeNmlDocument(shadow.doc!), name).toEqual(shadow.document);
    }
  });
});

describe("canvas map/HTML pair", () => {
  it("materializes the same scene from the block-prop mirror and from CRDT maps", () => {
    const input = loadFixture("canvas-html.json");
    const data = String((input.blocks[0].props as { data: string }).data);
    const mirror = canvasSceneFromMirror(data);

    const doc = new Y.Doc();
    const root = doc.getMap<unknown>(canvasMapName("canvas1")) as Y.Map<unknown>;
    populateCanvas(root, mirror);
    const maps = canvasSceneFromMaps(doc, "canvas1");
    expect(maps).not.toBeNull();
    expect(compareScenes(mirror, maps!)).toEqual([]);
  });

  it("equates the mirror scene with the converted NML canvas scene", () => {
    const input = loadFixture("canvas-html.json");
    const { document } = convertLegacyDocument(input, { createId: counter() });
    const data = String((input.blocks[0].props as { data: string }).data);
    const canvas = document.blocks[0] as NmlCanvasBlock;
    expect(compareScenes(canvasSceneFromMirror(data), canvas.scene)).toEqual([]);
  });

  it("reports a drift when a shape diverges between the two representations", () => {
    const input = loadFixture("canvas-html.json");
    const mirror = canvasSceneFromMirror(String((input.blocks[0].props as { data: string }).data));
    const drifted = structuredClone(mirror);
    drifted.nodes[0].x += 25;
    const diff = compareScenes(mirror, drifted);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff[0].class).toBe("canvas-shape-fields");
  });

  it("returns null map state for a block that has never been collaborated on", () => {
    expect(canvasSceneFromMaps(new Y.Doc(), "never")).toBeNull();
  });
});

describe("legacy ↔ NML comparison gate", () => {
  it("sustains semantic parity across the whole fixture corpus with only understood mismatches", () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
    for (const name of fixtureNames) {
      const input = loadFixture(name);
      const { document, diagnostics } = convertLegacyDocument(input, { createId: counter() });
      expect(errors(diagnostics), name).toEqual([]);
      expect(diagnostics.every((d) => UNDERSTOOD_LEGACY_CODES.has(d.code)), `${name}: ${JSON.stringify(diagnostics)}`).toBe(true);

      const comparison = compareLegacyToNml(input, document);
      const unexplained = comparison.mismatches.filter((m) => !m.understood);
      expect(unexplained, `${name}: ${JSON.stringify(unexplained)}`).toEqual([]);
      expect(comparison.ok, name).toBe(true);
    }
  });

  it("classifies the unsupported-block gap as understood", () => {
    const input = loadFixture("edge-cases.json");
    const { document } = convertLegacyDocument(input, { createId: counter() });
    const comparison = compareLegacyToNml(input, document);
    expect(comparison.mismatches.some((m) => m.class === "unsupported-block" && m.understood)).toBe(true);
    expect(comparison.ok).toBe(true);
  });

  it("catches a genuine divergence as an unexplained mismatch", () => {
    const input = loadFixture("rich-text.json");
    const { document } = convertLegacyDocument(input, { createId: counter() });
    // Corrupt the shadow's inline content: the comparator must notice.
    const paragraph = document.blocks[0] as NmlTextBlock;
    const corrupted = normalizeDocument({
      ...document,
      blocks: document.blocks.map((b) =>
        b.id === paragraph.id ? ({ ...paragraph, content: [{ type: "text", text: "totally different", marks: [] }] } as NmlTextBlock) : b,
      ),
    });
    const comparison = compareLegacyToNml(input, corrupted);
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatches.some((m) => m.class === "inline-semantics" && !m.understood)).toBe(true);
  });
});

describe("fuzzing", () => {
  it("never throws on arbitrary malformed legacy blocks", () => {
    let seed = 0x1234abcd;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
    const types = ["paragraph", "heading", "table", "codeBlock", "mathBlock", "canvas", "album", "image", "notionStub", "mystery", "toggleListItem"];
    for (let run = 0; run < 300; run++) {
      const blocks: LegacyBlock[] = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => {
        const type = types[Math.floor(rand() * types.length)];
        const content = rand() > 0.5 ? [{ type: "text", text: `t${Math.floor(rand() * 99)} < & >`, styles: rand() > 0.5 ? { bold: true } : {} }] : rand() > 0.5 ? "garbage" : undefined;
        return {
          id: rand() > 0.1 ? `f${run}-${i}` : undefined,
          type,
          props: { data: "", source: "x\ny", language: "ts", code: "z", level: Math.floor(rand() * 9), url: "", checked: rand() > 0.5 },
          content,
          children: rand() > 0.7 ? [{ id: `f${run}-${i}-c`, type: "paragraph", props: {}, content: [{ type: "text", text: "c", styles: {} }], children: [] }] : [],
        } as LegacyBlock;
      });
      expect(() => convertLegacyDocument({ documentId: `fuzz-${run}`, blocks }, { createId: counter() })).not.toThrow();
    }
  });
});
