import { describe, expect, it } from "vitest";
import { convertBlocks, type NotionBlock, type NotionLedgerEntry } from ".";
import { RAW_CAP, stubRaw, toBlockNote } from "./toBlockNote";

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const rich = (content: string) => ({
  type: "text",
  plain_text: content,
  text: { content },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
});
const block = (type: string, payload: unknown, extra: Partial<NotionBlock> = {}): NotionBlock =>
  ({ id: `notion-${type}`, type, [type]: payload, ...extra }) as NotionBlock;

const PAGE = "1a2b3c4d-5e6f-7081-9203-34a5b6c7d8e9";
const DB = "9f8e7d6c-5b4a-3021-8765-4321fedcba09";

/** What the import run hands the editor projection: the ledger's stubbed rows, by block id. */
const stubsOf = (ledger: NotionLedgerEntry[]) =>
  new Map(ledger.filter((e) => e.reason === "stubbed").map((e) => [e.blockId, e]));

const none = new Map<string, string>();

/**
 * The canonical document keeps a stub as a quote with a link; the editor shows
 * the same block locked. Both come from one conversion, so the test runs the
 * real converter and checks only the projection's half of the bargain.
 */
describe("the editor projection of a stub", () => {
  it("emits a locked notionStub for a block the ledger marks stubbed", () => {
    const result = convertBlocks([block("child_database", {}, { id: DB })], {
      createId: ids(),
      sourcePageId: PAGE,
    });
    const [stub] = toBlockNote(result.blocks, none, stubsOf(result.ledger));
    expect(stub).toMatchObject({
      type: "notionStub",
      props: {
        notionType: "child_database",
        notionId: DB,
        href: `https://www.notion.so/${PAGE.replace(/-/g, "")}#${DB.replace(/-/g, "")}`,
      },
    });
    expect(JSON.parse(stub.props.raw)).toEqual({ id: DB, type: "child_database", child_database: {} });
  });

  it("leaves the quote alone when no ledger is given — the form older imports already hold", () => {
    const result = convertBlocks([block("child_database", {})], { createId: ids() });
    const [quote] = toBlockNote(result.blocks, none);
    expect(quote.type).toBe("quote");
    expect(quote.content.at(-1)).toMatchObject({ type: "link" });
  });

  it("only stubs the blocks the ledger names, and reaches them inside children", () => {
    const result = convertBlocks(
      [
        block("bulleted_list_item", { rich_text: [rich("Parent")] }, {
          children: [block("unsupported", {}, { id: "u-1" })],
        }),
        block("paragraph", { rich_text: [rich("After")] }),
      ],
      { createId: ids() },
    );
    const blocks = toBlockNote(result.blocks, none, stubsOf(result.ledger));
    expect(blocks.map((b) => b.type)).toEqual(["bulletListItem", "paragraph"]);
    expect(blocks[0].children).toEqual([
      expect.objectContaining({ type: "notionStub", props: expect.objectContaining({ notionId: "u-1" }) }),
    ]);
  });

  it("does not stub a degraded block: only what the document could not hold", () => {
    const result = convertBlocks(
      [block("callout", { rich_text: [rich("Note")], icon: { type: "emoji", emoji: "💡" } })],
      { createId: ids() },
    );
    expect(result.ledger.map((e) => e.reason)).toContain("degraded");
    const blocks = toBlockNote(result.blocks, none, stubsOf(result.ledger));
    expect(blocks.some((b) => b.type === "notionStub")).toBe(false);
  });
});

describe("the raw JSON a stub carries", () => {
  it("is the Notion row without the children the fetcher walked in", () => {
    const synced = block(
      "synced_block",
      { synced_from: { block_id: "elsewhere" } },
      { id: "s-1", has_children: true, children: [block("paragraph", { rich_text: [rich("Inside")] })] },
    );
    const result = convertBlocks([synced], { createId: ids() });
    const [entry] = result.ledger;
    expect(entry.raw.children).toHaveLength(1);
    const raw = JSON.parse(stubRaw(entry));
    expect(raw).not.toHaveProperty("children");
    expect(raw).toMatchObject({ id: "s-1", type: "synced_block", has_children: true });
  });

  it("is left out entirely, never cut, past the cap", () => {
    const big = block("unsupported", { note: "x".repeat(RAW_CAP) }, { id: "big" });
    const result = convertBlocks([big], { createId: ids() });
    expect(stubRaw(result.ledger[0])).toBe("");
    const [stub] = toBlockNote(result.blocks, none, stubsOf(result.ledger));
    expect(stub).toMatchObject({ type: "notionStub", props: { notionId: "big", raw: "" } });
  });
});
