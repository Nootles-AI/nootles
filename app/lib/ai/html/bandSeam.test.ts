import { describe, expect, it } from "vitest";
import { DOMParser, parseHTML } from "linkedom";

// The block readers reach for the DOM every browser has and this runtime does
// not; lending it one keeps this a test of the grammar.
globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import type { AnyBlock } from "../projection";
import { compileDocHtml } from "./compile";
import { parseDocHtml } from "./parse";
import { redeemDrawnStubs, toDocHtml } from "./serialize";

/**
 * What the model reads and writes of a diagram's band. A read states the
 * width the diagram is drawn at, because the model has to know its room; no
 * write ever stores it, because it is the page's. Whatever the model writes
 * lands inside the band — scaled, never widened — at the one seam every
 * AI-authored diagram crosses. A storyboard's shots are frames, and none of
 * this touches them.
 */

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const parse = (html: string) => parseDocHtml(html, dom);

const RECT = '<nt-rect id="a" x="40" y="24" w="200" h="48"></nt-rect>';
const BAND = `<nt-diagram h="96">\n  ${RECT}\n</nt-diagram>`;
const WIDE = '<nt-diagram h="96" wide>\n  <nt-rect id="a" x="-200" y="24" w="1000" h="48"></nt-rect>\n</nt-diagram>';

function block(id: string, type: string, data: string): AnyBlock {
  return { id, type, props: { data }, content: undefined, children: [] } as unknown as AnyBlock;
}

/** The data of the one block a compile inserts, as the block would store it. */
function inserted(html: string): string {
  const op = compileDocHtml(parse(html), { current: [] }).ops.find((o) => o.kind === "insertBlocks");
  if (op?.kind !== "insertBlocks") throw new Error("nothing was inserted");
  return String(op.blocks[0].props?.data ?? "");
}

describe("the read form states the band's width", () => {
  it("a diagram in the column reads as 720 wide", () => {
    expect(toDocHtml([block("b1", "canvas", BAND)])).toBe(
      `<nt-diagram id="b1" w="720" h="96">\n  ${RECT}\n</nt-diagram>`,
    );
  });

  it("a wide one reads as 1200 wide, and says it is wide", () => {
    expect(toDocHtml([block("b2", "canvas", WIDE)])).toMatch(/^<nt-diagram id="b2" w="1200" h="96" wide>\n/);
  });

  it("an old root reads as the band it becomes — the column's width, never its own", () => {
    const html = toDocHtml([block("b3", "canvas", `<nt-diagram w="600" h="408">\n  ${RECT}\n</nt-diagram>`)]);
    expect(html).toMatch(/^<nt-diagram id="b3" w="720" h="\d+">/);
  });

  it("a stub redeems to the read, width and all", () => {
    const b1 = block("b1", "canvas", BAND);
    const stub = toDocHtml([b1], { collapseDiagrams: true });
    expect(stub).not.toContain('w="');
    expect(redeemDrawnStubs(stub, [b1])).toEqual({ html: toDocHtml([b1]), missing: [] });
  });
});

describe("no write stores the width", () => {
  it("an echo of the read compiles to nothing, whether the page is read or stored", () => {
    const echo = toDocHtml([block("b1", "canvas", BAND)]);
    expect(echo).toContain('w="720"');
    expect(compileDocHtml(parse(echo), { current: parse(echo) }).ops).toHaveLength(0);
    const stored = BAND.replace("<nt-diagram", '<nt-diagram id="b1"');
    expect(compileDocHtml(parse(echo), { current: parse(stored) }).ops).toHaveLength(0);
  });

  it("an echo with an edit lands the edit without the width", () => {
    const read = toDocHtml([block("b1", "canvas", BAND)]);
    const edited = read.replace('w="200"', 'w="240"');
    expect(compileDocHtml(parse(edited), { current: parse(read) }).ops).toEqual([
      { kind: "updateBlockProps", blockId: "b1", props: { data: BAND.replace('w="200"', 'w="240"') } },
    ]);
  });

  it("a new diagram written with the read's w is stored without it", () => {
    expect(inserted(`<nt-diagram w="720" h="96">${RECT}</nt-diagram>`)).toBe(BAND);
  });

  it("an old frame's hand-pinned size is dropped with it", () => {
    expect(inserted(`<nt-diagram w="720" h="96" data-width="fixed" data-height="fixed">${RECT}</nt-diagram>`)).toBe(
      BAND,
    );
  });
});

describe("a model's diagram lands inside its band", () => {
  it("content wider than the column is scaled about its top-left, and the height follows", () => {
    // 1440 across halves to 720; the stated 96 halves to 48, under the floor
    // the halved rect needs (24 + 24 + 24).
    expect(inserted('<nt-diagram h="96"><nt-rect id="a" x="0" y="24" w="1440" h="48"></nt-rect></nt-diagram>')).toBe(
      '<nt-diagram h="72">\n  <nt-rect id="a" x="0" y="24" w="720" h="24"></nt-rect>\n</nt-diagram>',
    );
  });

  it("a wide diagram keeps what it holds past the column", () => {
    expect(inserted(WIDE)).toBe(WIDE);
  });

  it("content above the top or left of the band is moved in, not cut", () => {
    expect(inserted('<nt-diagram h="96"><nt-rect id="a" x="-40" y="-10" w="200" h="48"></nt-rect></nt-diagram>')).toBe(
      '<nt-diagram h="96">\n  <nt-rect id="a" x="0" y="0" w="200" h="48"></nt-rect>\n</nt-diagram>',
    );
  });
});

describe("a storyboard is frames, never bands", () => {
  // A 640-wide shot, with a rect past its right edge and above its top.
  const BOARD =
    '<nt-storyboard ratio="16:9"><nt-shot>' +
    '<nt-diagram w="640" h="360"><nt-rect id="a" x="600" y="-20" w="200" h="80"></nt-rect></nt-diagram>' +
    "<nt-note>Past the frame.</nt-note></nt-shot></nt-storyboard>";

  it("a shot drawn past its frame compiles by the board's own rule, never fitted to a band", () => {
    const data = inserted(BOARD);
    expect(data).toBe(serializeStoryboard({ ...parseStoryboard(BOARD), id: undefined }));
    // The board scales the drawing into its 320 frame and keeps it as drawn. A
    // band fit would have dropped the w and pulled the rect down to y = 0.
    expect(data).toContain('<nt-diagram w="320" h="180">');
    expect(data).toContain('<nt-rect id="a" x="300" y="-10" w="100" h="40"></nt-rect>');
  });

  it("a shot reads as the frame it is, not as a band", () => {
    const read = toDocHtml([block("B1", "storyboard", serializeStoryboard(parseStoryboard(BOARD)))]);
    expect(read).toContain('<nt-diagram w="320" h="180">');
    expect(read).not.toContain('w="720"');
  });
});
