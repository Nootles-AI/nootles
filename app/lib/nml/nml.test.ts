import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  NML_SCHEMA_VERSION,
  migrateDocument,
  normalizeDocument,
  parseDocument,
  parseCanonicalDocument,
  repairDocument,
  serializeDocument,
  validateDocument,
  type NmlBlock,
  type NmlDocument,
  type NmlInlineContent,
  type NmlCanvasBlock,
  type NmlCodeBlock,
  type NmlTableBlock,
  type NmlTextBlock,
} from ".";

const text = (value: string): NmlInlineContent => [{ type: "text", text: value, marks: [] }];
const leaf = { props: {}, children: [] };

const allBlocks: NmlDocument = {
  schemaVersion: NML_SCHEMA_VERSION,
  documentId: "doc-1",
  blocks: [
    { id: "p-1", type: "paragraph", ...leaf, content: [
      { type: "text", text: "Every mark", marks: ["underline", "bold", "code", "italic", "strike"] },
      { type: "link", href: "https://example.com?a=1&b=2", content: [{ type: "text", text: " linked", marks: ["italic"] }] },
      { type: "math", id: "im-1", latex: "x < y" },
      { type: "pageRef", id: "ref-1", pageId: "page-2", fallbackTitle: "Other & page" },
    ] },
    { id: "h-1", type: "heading", props: { level: 2 }, children: [], content: text("Heading") },
    { id: "q-1", type: "quote", ...leaf, content: text("Quote") },
    { id: "b-1", type: "bulletListItem", props: {}, content: text("Bullet"), children: [
      { id: "b-2", type: "bulletListItem", props: {}, content: text("Nested"), children: [] },
    ] },
    { id: "n-1", type: "numberedListItem", props: { start: 3 }, content: text("Third"), children: [] },
    { id: "n-2", type: "numberedListItem", props: {}, content: text("Fourth"), children: [] },
    { id: "c-1", type: "checkListItem", props: { checked: true }, content: text("Done"), children: [] },
    { id: "t-1", type: "toggleListItem", props: {}, content: text("Details"), children: [
      { id: "p-2", type: "paragraph", ...leaf, content: text("Inside") },
    ] },
    { id: "table-1", type: "table", props: { headerRows: 1 }, columns: [{ id: "col-1" }, { id: "col-2" }], rows: [
      { id: "row-1", cells: [{ id: "cell-1", content: text("A") }, { id: "cell-2", content: text("B") }] },
      { id: "row-2", cells: [{ id: "cell-3", content: text("1") }, { id: "cell-4", content: text("2") }] },
    ], children: [] },
    { id: "code-1", type: "codeBlock", props: { language: "typescript" }, code: "if (a < b) {\n  x && y;\n}", children: [] },
    { id: "math-1", type: "mathBlock", props: {}, rows: [{ id: "mr-1", latex: "a & b" }, { id: "mr-2", latex: "c < d" }], children: [] },
    { id: "divider-1", type: "divider", ...leaf },
    { id: "image-1", type: "image", props: { source: { kind: "url", url: "/image.png" }, caption: "A picture" }, children: [] },
    { id: "video-1", type: "video", props: { source: { kind: "storage", storageId: "storage-1" } }, children: [] },
    { id: "audio-1", type: "audio", props: {}, children: [] },
    { id: "file-1", type: "file", props: { name: "notes.txt" }, children: [] },
    { id: "canvas-1", type: "canvas", props: {}, scene: {
      id: "canvas-1", w: 320, h: 180, style: {}, attrs: {},
      nodes: [
        { id: "shape-1", kind: "rect", x: 10, y: 20, w: 100, h: 50, rot: 0, style: {}, label: "Box", locked: false, hidden: false, attrs: {} },
        { id: "group-1", kind: "group", x: 0, y: 0, w: 200, h: 100, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {}, children: [
          { id: "shape-2", kind: "ellipse", x: 5, y: 5, w: 20, h: 20, rot: 0, style: {}, label: "", locked: false, hidden: false, attrs: {} },
        ] },
      ],
      edges: [{ id: "edge-1", from: "shape-1", to: "shape-2", label: "to", style: {}, attrs: {} }],
    }, children: [] },
    { id: "album-1", type: "album", props: {}, domain: { id: "album-1", items: [{ kind: "image", src: "/one.jpg", w: 3, h: 2 }] }, legacyMarkup: '<gallery source="old">kept & safe</gallery>', children: [] },
    { id: "story-1", type: "storyboard", props: {}, domain: { id: "story-1", ratio: "16:9", shots: [{ scene: "", note: "First shot" }] }, children: [] },
    { id: "location-1", type: "location", props: {}, domain: { id: "location-1", name: "Somewhere", images: [], off: [] }, children: [] },
  ],
};

describe("canonical NML", () => {
  it("has a golden serialization covering every v1 block and inline node", () => {
    expect(serializeDocument(allBlocks)).toMatchSnapshot();
  });

  it("round-trips semantic content and stable IDs", () => {
    const canonical = serializeDocument(allBlocks);
    const parsed = parseDocument(canonical);
    expect(serializeDocument(parsed.document!)).toBe(canonical);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.quarantine).toEqual([]);
    expect(parsed.document).toEqual(normalizeDocument(allBlocks));
    expect(parseCanonicalDocument(canonical)).toEqual(parsed.document);
  });

  it("produces the same AST through Node and DOMParser-compatible entry points", () => {
    const canonical = serializeDocument(allBlocks);
    const node = parseDocument(canonical);
    const dom = parseDocument(canonical, {
      parseHtml: (html) => new DOMParser().parseFromString(html, "text/html") as unknown as Document,
    });
    expect(dom).toEqual(node);
  });

  it("normalizes idempotently and preserves code/math whitespace", () => {
    const input = structuredClone(allBlocks);
    const paragraph = input.blocks[0] as NmlTextBlock;
    paragraph.content = [
      { type: "text", text: "a\n", marks: ["bold", "code", "bold"] },
      { type: "text", text: " b", marks: ["code", "bold"] },
      { type: "text", text: "", marks: [] },
    ];
    const once = normalizeDocument(input);
    expect(normalizeDocument(once)).toEqual(once);
    expect((once.blocks[0] as typeof paragraph).content).toEqual([{ type: "text", text: "a b", marks: ["code", "bold"] }]);
    expect((once.blocks[9] as NmlCodeBlock).code).toContain("\n  ");
  });

  it("rejects unsafe links, duplicate IDs, dangling edges, and uneven tables", () => {
    const input = structuredClone(allBlocks);
    (input.blocks[0] as NmlTextBlock).content.push({ type: "link", href: "javascript:alert(1)", content: text("bad") as [{ type: "text"; text: string; marks: [] }] });
    input.blocks[1].id = "p-1";
    (input.blocks[8] as NmlTableBlock).rows[0].cells.pop();
    (input.blocks[16] as NmlCanvasBlock).scene.edges[0].to = "missing";
    expect(validateDocument(input).map(({ code }) => code)).toEqual(expect.arrayContaining(["unsafe_url", "duplicate_id", "table_width", "dangling_edge"]));
  });

  it("repairs later duplicate IDs deterministically without mutating input", () => {
    const input = structuredClone(allBlocks);
    input.blocks[1].id = "p-1";
    const repaired = repairDocument(input);
    expect(repaired.document?.blocks[1].id).toMatch(/^repair-[0-9a-f]{16}$/);
    expect(repairDocument(input).document?.blocks[1].id).toBe(repaired.document?.blocks[1].id);
    expect(input.blocks[1].id).toBe("p-1");
    expect(repaired.issues[0].code).toBe("duplicate_id_repaired");
  });

  it("migrates as a pure clone and refuses implicit legacy/newer versions", () => {
    const migrated = migrateDocument(allBlocks);
    expect(migrated).toEqual(normalizeDocument(allBlocks));
    expect(migrated).not.toBe(allBlocks);
    expect(() => migrateDocument({ ...allBlocks, schemaVersion: 0 })).toThrow(/legacy converter/);
    expect(() => migrateDocument({ ...allBlocks, schemaVersion: 2 })).toThrow(/newer/);
  });

  it("fuzzes malformed markup without throwing or silently losing unknown elements", () => {
    const malformed = ["", "<script>alert(1)</script>", "<nt-document", '<nt-document id="d" schema-version="1"><wat secret="x">keep</wat></nt-document>'];
    for (const source of malformed) {
      const result = parseDocument(source, { mode: "import", createId: () => "minted" });
      expect(result.diagnostics.length).toBeGreaterThan(0);
      if (source.includes("<wat")) expect(result.quarantine[0]?.markup).toContain("keep");
    }
    let seed = 0xbadf00d;
    const alphabet = '<>/="&; abcdefntml0123456789';
    for (let run = 0; run < 500; run++) {
      let source = "";
      const length = 1 + ((seed = (seed * 1103515245 + 12345) >>> 0) % 200);
      for (let index = 0; index < length; index++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        source += alphabet[seed % alphabet.length];
      }
      expect(() => parseDocument(source, { mode: "import", createId: () => "minted" })).not.toThrow();
    }
    expect(() => parseCanonicalDocument("<p>not canonical</p>")).toThrow(/nt-document/);
  });

  it("retains noncanonical custom-domain source as inert migration markup", () => {
    const result = parseDocument(
      '<nt-document id="d" schema-version="1"><gallery id="a"><figure mystery="kept"><img src="/a.jpg" w="3" h="2"></figure></gallery></nt-document>',
      { mode: "import", createId: () => "minted" },
    );
    const album = result.document?.blocks[0];
    expect(album?.type).toBe("album");
    if (album?.type !== "album") throw new Error("Expected album");
    expect(album.legacyMarkup).toContain('mystery="kept"');
    expect(serializeDocument(result.document!)).toContain("&lt;gallery");
  });

  it("property-checks many generated valid documents", () => {
    let seed = 0x5eed1234;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
    for (let run = 0; run < 250; run++) {
      const blocks: NmlBlock[] = Array.from({ length: Math.floor(random() * 12) }, (_, index) => ({
        id: `r${run}-b${index}`,
        type: "paragraph" as const,
        props: {},
        children: [],
        content: [{ type: "text" as const, text: `value ${Math.floor(random() * 1000)} < & >`, marks: random() > 0.5 ? ["bold" as const] : [] }],
      }));
      const document: NmlDocument = { schemaVersion: 1, documentId: `generated-${run}`, blocks };
      const canonical = serializeDocument(document);
      const parsed = parseDocument(canonical);
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.document).toEqual(normalizeDocument(document));
    }
  });
});
