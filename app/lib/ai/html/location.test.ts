import { describe, expect, it } from "vitest";
import { DOMParser, parseHTML } from "linkedom";

// The block-level serializer reaches for the card's own parser, which reaches
// for the DOM every browser has and this runtime does not. Lending it one is
// what makes this a test of the grammar rather than of the environment.
globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
import { parseDocHtml } from "./parse";
import { toDocHtml } from "./serialize";
import { compileDocHtml } from "./compile";

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const parse = (html: string) => parseDocHtml(html, dom);

/**
 * A place card is how the agent answers "cafés on my route". What has to hold:
 * the element it writes becomes a location block with the card on it, the card
 * is taken WHOLE (its <img> children are the card's pictures, not three image
 * blocks), and a card read back out is the same text it was written as.
 */
const CARD =
  '<nt-location name="Blue Bottle Coffee" address="1 Ferry Building, San Francisco, CA"' +
  ' at="37.7955,-122.3937" place="ChIJexample" rating="4.4" votes="1284">\n' +
  "  <note>Fast wifi, good for mornings.</note>\n" +
  '  <img src="/api/places/photo?ref=places/a/photos/b">\n' +
  '  <img src="/api/places/photo?ref=places/a/photos/c" off>\n' +
  "</nt-location>";

describe("a place card in the document grammar", () => {
  it("is one block, not one per picture", () => {
    const nodes = parse(`<p>Near the water:</p>${CARD}`);
    expect(nodes.map((node) => node.type)).toEqual(["paragraph", "location"]);
  });

  it("compiles a written card into an insert carrying it", () => {
    const batch = compileDocHtml(parse(CARD), { current: [] });
    const insert = batch.ops.find((op) => op.kind === "insertBlocks");
    expect(insert?.kind).toBe("insertBlocks");
    const block = insert!.kind === "insertBlocks" ? insert!.blocks[0] : null;
    expect(block?.type).toBe("location");
    const data = String(block?.props?.data ?? "");
    expect(data).toContain('name="Blue Bottle Coffee"');
    expect(data).toContain('rating="4.4"');
    // Normalised on the way in: the id belongs to the block, not the markup.
    expect(data).not.toContain("id=");
  });

  it("round-trips a stored card through the grammar", () => {
    const block = {
      id: "b7",
      type: "location",
      props: { data: CARD },
    };
    const html = toDocHtml([block]);
    expect(html).toContain('<nt-location id="b7" name="Blue Bottle Coffee"');
    expect(parse(html)).toEqual([{ type: "location", id: "b7", html: expect.any(String) }]);
    // And what comes back is what the block holds: read out, sent straight
    // back in, the compiler finds nothing to do.
    const again = compileDocHtml(parse(html), { current: parse(html) });
    expect(again.ops).toHaveLength(0);
  });

  it("sees a card the reader has changed as one change, not several", () => {
    const before = { id: "b7", type: "location", props: { data: CARD } };
    const edited = CARD.replace(">\n  <note>", ' off="rating">\n  <note>');
    const batch = compileDocHtml(parse(toDocHtml([{ ...before, props: { data: edited } }])), {
      current: parse(toDocHtml([before])),
    });
    expect(batch.ops).toHaveLength(1);
    expect(batch.ops[0].kind).toBe("updateBlockProps");
  });
});
