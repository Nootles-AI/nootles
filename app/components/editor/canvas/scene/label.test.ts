import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import {
  blocksToLabel,
  hasBlocks,
  indentOf,
  labelBlocks,
  labelOfElement,
  labelRuns,
  labelText,
  listOf,
  NO_MARKS,
  paragraphSpacingOf,
  runsToLabel,
  withIndent,
  withList,
  withParagraphSpacing,
} from "./label";

const canonical = (label: string) => blocksToLabel(labelBlocks(label));

const element = (html: string) => {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById("r")!;
};

describe("canonical labels", () => {
  it("writes a bold-only label exactly as it always did", () => {
    const label = "Order <b>received</b> today";
    expect(canonical(label)).toBe(label);
    expect(labelRuns(label)).toEqual([
      { kind: "text", text: "Order ", marks: NO_MARKS },
      { kind: "text", text: "received", marks: { bold: true } },
      { kind: "text", text: " today", marks: NO_MARKS },
    ]);
  });

  it("keeps refs and escapes as they were", () => {
    const label = 'See <nt-ref page="p1">Plan &amp; scope</nt-ref> &lt;now&gt;';
    expect(canonical(label)).toBe(label);
    expect(labelText(label)).toBe("See Plan & scope <now>");
  });

  it("nests marks in one order whatever order they were written in", () => {
    expect(canonical("<i><b>x</b></i>")).toBe("<b><i>x</i></b>");
    expect(canonical("<u><s><i><b>x</b></i></s></u>")).toBe("<b><i><u><s>x</s></u></i></b>");
  });

  it("keeps tags open across runs that share them", () => {
    const runs = labelRuns("<b>one <i>two</i> three</b>");
    expect(runs).toEqual([
      { kind: "text", text: "one ", marks: { bold: true } },
      { kind: "text", text: "two", marks: { bold: true, italic: true } },
      { kind: "text", text: " three", marks: { bold: true } },
    ]);
    expect(runsToLabel(runs)).toBe("<b>one <i>two</i> three</b>");
  });

  it("spells a span's style with sorted keys", () => {
    const label = '<span style="font-size: 24px; color: red">big</span>';
    expect(canonical('<span style="color:red;font-size:24px">big</span>')).toBe(
      '<span style="color: red; font-size: 24px">big</span>',
    );
    expect(labelRuns(label)[0]).toEqual({
      kind: "text",
      text: "big",
      marks: { style: { "font-size": "24px", color: "red" } },
    });
  });

  it("drops declarations a run may not carry", () => {
    expect(canonical('<span style="position: absolute; color: red">x</span>')).toBe(
      '<span style="color: red">x</span>',
    );
  });

  it("links wrap the styled text, not the other way round", () => {
    const label = '<a href="https://x.y">go <b>now</b></a>';
    expect(canonical(label)).toBe(label);
  });

  it("tolerates unbalanced tags", () => {
    expect(canonical("</b>plain<b>")).toBe("plain");
    expect(canonical("<b>open")).toBe("<b>open</b>");
  });

  it("shows unknown markup as the words it is", () => {
    const label = "a &lt;q&gt; b";
    expect(labelText(label)).toBe("a <q> b");
    expect(canonical(label)).toBe(label);
  });
});

describe("paragraphs and lists", () => {
  it("writes one bare paragraph without a <p>", () => {
    expect(blocksToLabel([{ kind: "p", runs: [{ kind: "text", text: "hi", marks: NO_MARKS }] }])).toBe("hi");
    expect(hasBlocks("hi")).toBe(false);
  });

  it("round-trips paragraphs with spacing and indent", () => {
    const label = '<p style="margin-bottom: 8px">one</p><p style="margin-bottom: 8px">two</p><p>three</p>';
    expect(canonical(label)).toBe(label);
    expect(hasBlocks(label)).toBe(true);
    expect(labelText(label)).toBe("one\ntwo\nthree");
    expect(paragraphSpacingOf(label)).toBe(8);
  });

  it("round-trips lists", () => {
    const label = "<ul><li>a</li><li><b>b</b></li></ul><p>after</p>";
    expect(canonical(label)).toBe(label);
    expect(listOf(label)).toBe("ul");
    expect(labelBlocks(label)[1]).toEqual({
      kind: "li",
      list: "ul",
      runs: [{ kind: "text", text: "b", marks: { bold: true } }],
    });
  });

  it("applies and clears paragraph spacing", () => {
    const spaced = withParagraphSpacing("<p>a</p><p>b</p>", 12);
    expect(spaced).toBe('<p style="margin-bottom: 12px">a</p><p>b</p>');
    expect(withParagraphSpacing(spaced, 0)).toBe("<p>a</p><p>b</p>");
    // One paragraph never carries spacing: there is nothing below it.
    expect(withParagraphSpacing("solo", 12)).toBe("solo");
  });

  it("applies indent and lists to every block", () => {
    const indented = withIndent("<p>a</p><p>b</p>", 16);
    expect(indented).toBe('<p style="text-indent: 16px">a</p><p style="text-indent: 16px">b</p>');
    expect(indentOf(indented)).toBe(16);
    expect(withList("<p>a</p><p>b</p>", "ol")).toBe("<ol><li>a</li><li>b</li></ol>");
    expect(withList("<ol><li>a</li><li>b</li></ol>", "")).toBe("<p>a</p><p>b</p>");
  });
});

describe("reading the DOM", () => {
  it("reads tags and their styled-span spellings alike", () => {
    expect(labelOfElement(element("<strong>a</strong> <em>b</em>"))).toBe("<b>a</b> <i>b</i>");
    expect(labelOfElement(element('<span style="font-weight: 700">a</span>'))).toBe("<b>a</b>");
    expect(labelOfElement(element('<span style="font-style: italic; color: red">a</span>'))).toBe(
      '<span style="color: red"><i>a</i></span>',
    );
    expect(labelOfElement(element('<span style="text-decoration: underline line-through">a</span>'))).toBe(
      "<u><s>a</s></u>",
    );
  });

  it("reads a browser's <font> and merges nested spans, inner winning", () => {
    expect(labelOfElement(element('<font color="blue">a</font>'))).toBe('<span style="color: blue">a</span>');
    expect(
      labelOfElement(element('<span style="color: red; font-size: 12px"><span style="color: blue">a</span></span>')),
    ).toBe('<span style="color: blue; font-size: 12px">a</span>');
  });

  it("keeps a safe link and flattens an unsafe one", () => {
    expect(labelOfElement(element('<a href="https://x.y">a</a>'))).toBe('<a href="https://x.y">a</a>');
    expect(labelOfElement(element('<a href="javascript:alert(1)">a</a>'))).toBe("a");
  });

  it("reads breaks, divs, paragraphs and lists", () => {
    expect(labelOfElement(element("a<br>b"))).toBe("a\nb");
    expect(labelOfElement(element("a<div>b</div>"))).toBe("a\nb");
    expect(labelOfElement(element('<p style="margin-bottom: 8px">a</p><p>b</p>'))).toBe(
      '<p style="margin-bottom: 8px">a</p><p>b</p>',
    );
    expect(labelOfElement(element("<ul><li>a</li><li>b</li></ul>"))).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("drops the empty paragraph an editable leaves at the end", () => {
    expect(labelOfElement(element("<p>a</p><p><br></p>"))).toBe("a");
    expect(labelOfElement(element("<p>a</p><p>b</p><p></p>"))).toBe("<p>a</p><p>b</p>");
  });

  it("keeps chips and escapes typed brackets", () => {
    expect(labelOfElement(element('x <span data-page="p1" data-title="T">T</span> &lt;y&gt;'))).toBe(
      'x <nt-ref page="p1">T</nt-ref> <y>'.replace("<y>", "&lt;y&gt;"),
    );
  });
});
