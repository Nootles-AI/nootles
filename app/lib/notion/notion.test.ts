import { describe, expect, it } from "vitest";
import { LANGUAGES } from "@/app/components/editor/codemirror/languages";
import { validateDocument } from "@/app/lib/nml/validate";
import type { NmlBlock, NmlCodeBlock, NmlTableBlock, NmlTextBlock } from "@/app/lib/nml/schema";
import { NOTION_LANGUAGES, convertBlocks, convertPage, type NotionBlock } from ".";

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const convert = (blocks: NotionBlock[], resolvePage?: (id: string) => string | undefined) =>
  convertBlocks(blocks, { createId: ids(), resolvePage });

const rich = (content: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  plain_text: content,
  text: { content },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  ...extra,
});
const block = (type: string, payload: unknown, extra: Partial<NotionBlock> = {}): NotionBlock =>
  ({ id: `notion-${type}`, type, [type]: payload, ...extra }) as NotionBlock;

const codes = (result: { diagnostics: { code: string }[] }) => result.diagnostics.map((d) => d.code);

describe("direct translations", () => {
  it("carries paragraphs, headings, lists and marks across intact", () => {
    const result = convert([
      block("paragraph", { rich_text: [rich("Plain")] }),
      block("heading_2", { rich_text: [rich("Title")] }),
      block("to_do", { rich_text: [rich("Done")], checked: true }),
      block("divider", {}),
    ]);
    expect(result.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "checkListItem", "divider"]);
    expect(result.blocks[1]).toMatchObject({ type: "heading", props: { level: 2 } });
    expect(result.blocks[2]).toMatchObject({ props: { checked: true } });
    expect(result.diagnostics).toEqual([]);
  });

  it("maps all five annotations onto the five NML marks", () => {
    const result = convert([
      block("paragraph", {
        rich_text: [rich("Loud", {
          annotations: { bold: true, italic: true, strikethrough: true, underline: true, code: true, color: "default" },
        })],
      }),
    ]);
    const paragraph = result.blocks[0] as NmlTextBlock;
    expect(paragraph.content[0]).toMatchObject({
      type: "text",
      marks: ["code", "bold", "italic", "strike", "underline"],
    });
  });

  it("produces a document that validates as NML", () => {
    const { document } = convertPage("doc-1", [
      block("paragraph", { rich_text: [rich("Hello")] }),
      block("bulleted_list_item", { rich_text: [rich("One")] }, {
        children: [block("bulleted_list_item", { rich_text: [rich("Nested")] })],
      }),
      block("equation", { expression: "e^{i\\pi} = -1" }),
    ], { createId: ids() });
    expect(validateDocument(document)).toEqual([]);
  });

  it("turns an equation block into a single-row math block", () => {
    const result = convert([block("equation", { expression: "x^2" })]);
    expect(result.blocks[0]).toMatchObject({ type: "mathBlock", rows: [{ latex: "x^2" }] });
  });
});

describe("semi-translations", () => {
  it("drops colour and says so", () => {
    const result = convert([
      block("paragraph", { rich_text: [rich("Red", { annotations: { color: "red" } })] }),
    ]);
    expect(codes(result)).toContain("colour_dropped");
    expect((result.blocks[0] as NmlTextBlock).content[0]).toMatchObject({ marks: [] });
  });

  it("turns a callout into a quote carrying its emoji", () => {
    const result = convert([
      block("callout", { rich_text: [rich("Careful")], icon: { type: "emoji", emoji: "⚠️" } }),
    ]);
    const quote = result.blocks[0] as NmlTextBlock;
    expect(quote.type).toBe("quote");
    expect(quote.content[0]).toMatchObject({ text: "⚠️ " });
    expect(codes(result)).toContain("callout_as_quote");
    expect(result.ledger[0]).toMatchObject({ notionType: "callout", reason: "degraded" });
  });

  it("flattens children of blocks that cannot hold them", () => {
    const result = convert([
      block("paragraph", { rich_text: [rich("Parent")] }, {
        children: [block("paragraph", { rich_text: [rich("Child")] })],
      }),
    ]);
    expect(result.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(result.blocks[0].children).toEqual([]);
    expect(codes(result)).toContain("children_flattened");
  });

  it("nests list items and stops at the depth limit", () => {
    const nest = (depth: number): NotionBlock =>
      block("bulleted_list_item", { rich_text: [rich(`L${depth}`)] }, {
        children: depth < 6 ? [nest(depth + 1)] : [],
      });
    const result = convert([nest(1)]);
    let node: NmlBlock | undefined = result.blocks[0];
    let levels = 0;
    while (node) {
      levels++;
      node = node.children[0];
    }
    expect(levels).toBe(4);
    expect(codes(result)).toContain("depth_limit_flattened");
    // Nothing is lost: the overflow becomes siblings at the deepest legal level.
    const count = (blocks: NmlBlock[]): number =>
      blocks.reduce((total, node) => total + 1 + count(node.children), 0);
    expect(count(result.blocks)).toBe(6);
  });

  it("flattens columns into sequence", () => {
    const result = convert([
      block("column_list", {}, {
        children: [
          block("column", {}, { children: [block("paragraph", { rich_text: [rich("Left")] })] }),
          block("column", {}, { children: [block("paragraph", { rich_text: [rich("Right")] })] }),
        ],
      }),
    ]);
    expect(result.blocks.map((b) => (b as NmlTextBlock).content[0])).toMatchObject([
      { text: "Left" },
      { text: "Right" },
    ]);
    expect(codes(result)).toContain("columns_flattened");
  });

  it("builds a table and reports the header column it cannot keep", () => {
    const result = convert([
      block("table", { table_width: 2, has_column_header: true, has_row_header: true }, {
        children: [
          block("table_row", { cells: [[rich("A")], [rich("B")]] }),
          block("table_row", { cells: [[rich("1")], [rich("2")]] }),
        ],
      }),
    ]);
    const table = result.blocks[0] as NmlTableBlock;
    expect(table.props.headerRows).toBe(1);
    expect(table.columns).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells[1].content[0]).toMatchObject({ text: "B" });
    expect(codes(result)).toContain("row_header_dropped");
  });

  it("maps known code languages and falls back loudly", () => {
    const result = convert([
      block("code", { rich_text: [rich("const a = 1")], language: "typescript" }),
      block("code", { rich_text: [rich("SELECT")], language: "brainfuck" }),
    ]);
    expect((result.blocks[0] as NmlCodeBlock).props.language).toBe("typescript");
    expect((result.blocks[1] as NmlCodeBlock).props.language).toBe("plaintext");
    expect(codes(result)).toContain("code_language_unmapped");
  });

  it("turns bookmarks and embeds into links", () => {
    const result = convert([
      block("bookmark", { url: "https://example.com", caption: [rich("A site")] }),
    ]);
    expect((result.blocks[0] as NmlTextBlock).content[0]).toMatchObject({
      type: "link",
      href: "https://example.com",
    });
    expect(codes(result)).toContain("preview_as_link");
  });

  it("inlines a synced original and stubs a synced copy", () => {
    const original = convert([
      block("synced_block", { synced_from: null }, {
        children: [block("paragraph", { rich_text: [rich("Shared")] })],
      }),
    ]);
    expect(original.blocks.map((b) => b.type)).toEqual(["paragraph"]);
    const copy = convert([block("synced_block", { synced_from: { block_id: "abc" } })]);
    expect(copy.ledger[0]).toMatchObject({ reason: "stubbed" });
  });

  it("drops navigation blocks and records them", () => {
    const result = convert([block("table_of_contents", {}), block("breadcrumb", {})]);
    expect(result.blocks).toEqual([]);
    expect(result.ledger.map((e) => e.reason)).toEqual(["dropped", "dropped"]);
  });
});

describe("page references", () => {
  it("uses a pageRef inside the import set and a link outside it", () => {
    const inside = convert(
      [block("child_page", { title: "Notes" }, { id: "n-1" })],
      (id) => (id === "n-1" ? "nootles-page-1" : undefined),
    );
    expect((inside.blocks[0] as NmlTextBlock).content[0]).toMatchObject({
      type: "pageRef",
      pageId: "nootles-page-1",
    });

    const outside = convert([block("child_page", { title: "Elsewhere" }, { id: "n-2" })]);
    expect((outside.blocks[0] as NmlTextBlock).content[0]).toMatchObject({ type: "link" });
    expect(codes(outside)).toContain("page_outside_import");
  });

  it("resolves page mentions the same way", () => {
    const result = convert(
      [block("paragraph", {
        rich_text: [{ type: "mention", plain_text: "Target", mention: { type: "page", page: { id: "n-9" } } }],
      })],
      (id) => (id === "n-9" ? "nootles-page-9" : undefined),
    );
    expect((result.blocks[0] as NmlTextBlock).content[0]).toMatchObject({ type: "pageRef" });
  });
});

describe("media", () => {
  it("records an asset request and flags Notion-hosted URLs as expiring", () => {
    const result = convert([
      block("image", { file: { url: "https://notion.so/signed.png", expiry_time: "soon" }, caption: [rich("Shot")] }),
      block("image", { external: { url: "https://example.com/a.png" } }),
    ]);
    expect(result.assets).toMatchObject([
      { kind: "image", expiring: true },
      { kind: "image", expiring: false },
    ]);
    expect(result.blocks[0]).toMatchObject({ type: "image", props: { caption: "Shot" } });
  });

  it("stubs media with an unusable URL rather than writing an invalid block", () => {
    const result = convert([block("image", { external: { url: "javascript:alert(1)" } })]);
    expect(result.blocks[0].type).toBe("quote");
    expect(result.ledger[0]).toMatchObject({ reason: "stubbed" });
  });
});

describe("the unbounded set", () => {
  it("stubs an unknown block, keeps its JSON, and never drops it silently", () => {
    const unknown = block("some_future_integration", { whatever: true });
    const result = convert([unknown]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe("quote");
    const content = (result.blocks[0] as NmlTextBlock).content;
    expect(content.at(-1)).toMatchObject({ type: "link" });
    expect(result.ledger[0]).toMatchObject({
      notionType: "some_future_integration",
      reason: "stubbed",
      raw: unknown,
    });
    expect(codes(result)).toContain("notion_block_stubbed");
  });

  it("stubs Notion's own unsupported placeholder", () => {
    const result = convert([block("unsupported", {})]);
    expect(result.ledger[0]).toMatchObject({ reason: "stubbed" });
  });

  it("every stub still validates as NML", () => {
    const { document } = convertPage("doc-2", [block("mystery", {})], { createId: ids() });
    expect(validateDocument(document)).toEqual([]);
  });
});

describe("the language map", () => {
  it("only ever targets a grammar the editor can load", () => {
    const known = new Set(LANGUAGES.map((language) => language.id));
    for (const target of Object.values(NOTION_LANGUAGES)) {
      expect(known, `${target} is not a Nootles grammar`).toContain(target);
    }
  });
});
