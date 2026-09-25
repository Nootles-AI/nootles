import { describe, expect, test } from "vitest";
import { cleanSection, outlineOf, SECTION_REF, splitSection } from "./writer";

describe("cleanSection", () => {
  test("takes off a code fence and every block id, keeping shape ids", () => {
    const reply = [
      "```html",
      '<h2 id="arch">Architecture</h2>',
      '<p id="x1" at="x1">The <strong>browser</strong> talks to Convex.</p>',
      '<nt-diagram id="d1" w="600" h="200"><nt-rect id="browser" x="40" y="40" w="120" h="60">Browser</nt-rect>',
      '<nt-edge from="browser" to="convex"></nt-edge></nt-diagram>',
      "```",
    ].join("\n");
    const html = cleanSection(reply);
    expect(html).not.toContain("```");
    expect(html).toContain("<h2>Architecture</h2>");
    expect(html).toContain("<p>The <strong>browser</strong>");
    expect(html).toContain('<nt-diagram w="600" h="200">');
    expect(html).toContain('<nt-rect id="browser"');
    expect(html).toContain('from="browser"');
  });

  test("leaves code and maths exactly as written", () => {
    const code = '<nt-code-block lang="html"><p id="keep">literal</p></nt-code-block>';
    const html = cleanSection(`<nt-code-block id="c9" lang="html"><p id="keep">literal</p></nt-code-block>`);
    expect(html).toBe(code);
  });
});

describe("outlineOf", () => {
  test("headings, top-level blocks and diagrams", () => {
    const outline = outlineOf(
      [
        "<h2>Data model</h2>",
        "<p>Every row is owner-scoped.</p>",
        "<table><tr><th>Table</th></tr><tr><td>pages</td></tr></table>",
        "<ul><li>one</li><li>two</li></ul>",
        '<nt-diagram w="600" h="200"><nt-rect x="1" y="1" w="1" h="1"><p>label</p></nt-rect></nt-diagram>',
        '<nt-code-block lang="typescript"><h2>not a heading</h2></nt-code-block>',
      ].join("\n"),
    );
    expect(outline).toEqual({ headings: ["Data model"], blocks: 6, diagrams: 1 });
  });
});

describe("SECTION_REF", () => {
  test("finds each placed section's ref", () => {
    const html = '<p id="a">x</p>\n<nt-section ref="w3f9a1c"></nt-section>\n<nt-section ref="w0b2"> </nt-section>';
    expect([...html.matchAll(SECTION_REF)].map((m) => m[1])).toEqual(["w3f9a1c", "w0b2"]);
  });
});

describe("splitSection", () => {
  test("the writer's closing list comes off the page and back as statements", () => {
    const stored = "<h2>Comments</h2>\n<p>Threads anchor to text.</p>\n<!-- unsourced:\n- authors alone delete comments\n* moderators can resolve | a digest runs nightly\n-->";
    expect(splitSection(stored)).toEqual({
      html: "<h2>Comments</h2>\n<p>Threads anchor to text.</p>",
      unsourced: ["authors alone delete comments", "moderators can resolve", "a digest runs nightly"],
    });
  });

  test("a section with nothing flagged is itself", () => {
    expect(splitSection("<p>x</p>")).toEqual({ html: "<p>x</p>", unsourced: [] });
  });
});
