import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileDocHtml } from "./compile";
import { parseDocHtml } from "./parse";
import { runsToHtml, runsToHtmlFromRuns, toDocHtml } from "./serialize";

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const parse = (html: string) => parseDocHtml(html, dom);

/**
 * The tick box in the document grammar (NT-41).
 *
 * A user asked for a habit tracker and got a table of `☐` characters, because
 * the grammar had no box a table cell could hold: the to-do list is a block,
 * and a cell holds inline content. `<nt-check>` is that box. What has to hold
 * here: a model can write one and read one back unchanged, the spellings it
 * reaches for instead are accepted, and the bare `<input type="checkbox">` it
 * already knows still means the LIST item's marker where that is what it is.
 */
describe("the tick box in the document grammar", () => {
  it("parses an empty and a ticked box out of a table cell", () => {
    expect(
      parse(
        "<table><tr><td>Water</td><td><nt-check></nt-check></td><td><nt-check checked></nt-check></td></tr></table>",
      ),
    ).toEqual([
      {
        type: "table",
        id: undefined,
        header: false,
        rows: [
          [
            [{ type: "text", text: "Water" }],
            [{ type: "checkbox", checked: false }],
            [{ type: "checkbox", checked: true }],
          ],
        ],
      },
    ]);
  });

  it("round-trips a stored cell back to the element it parsed from", () => {
    // The serializer lays a table out over lines; the grammar is the same.
    const html =
      '<table id="t1">\n  <tr><td><nt-check></nt-check></td><td><nt-check checked></nt-check></td></tr>\n</table>';
    const nodes = parse(html);
    const block = {
      id: "t1",
      type: "table",
      props: {},
      content: {
        type: "tableContent",
        rows: [
          {
            cells: [
              { type: "tableCell", content: [{ type: "checkbox", props: { checked: false } }] },
              { type: "tableCell", content: [{ type: "checkbox", props: { checked: true } }] },
            ],
          },
        ],
      },
      children: [],
    };
    expect(toDocHtml([block])).toBe(html);
    // …and the runs the parse produced say the same thing back.
    expect(runsToHtmlFromRuns(nodes[0].type === "table" ? nodes[0].rows[0][1] : [])).toBe(
      "<nt-check checked></nt-check>",
    );
  });

  it("accepts the tags a model might reach for instead", () => {
    for (const tag of ["check", "checkbox", "nt-checkbox", "todo", "nt-todo"]) {
      expect(parse(`<p><${tag} checked></${tag}></p>`)).toEqual([
        { type: "paragraph", id: undefined, content: [{ type: "checkbox", checked: true }] },
      ]);
    }
  });

  it("reads a bare <input type=checkbox> in a cell as a box, since that is what a model writes first", () => {
    expect(
      parse('<table><tr><td><input type="checkbox" checked></td></tr></table>'),
    ).toEqual([
      {
        type: "table",
        header: false,
        rows: [[[{ type: "checkbox", checked: true }]]],
      },
    ]);
  });

  it("leaves the LIST item's own marker to the list item", () => {
    // Unchanged behaviour: the input is the item's type, not a box in its words.
    expect(parse('<ul><li><input type="checkbox" checked>Ship it</li></ul>')).toEqual([
      {
        type: "checkListItem",
        id: undefined,
        checked: true,
        content: [{ type: "text", text: "Ship it" }],
      },
    ]);
    // A box the item's words really do contain is still a box.
    const nodes = parse('<ul><li><input type="checkbox">Ship <nt-check checked></nt-check></li></ul>');
    expect(nodes).toEqual([
      {
        type: "checkListItem",
        id: undefined,
        checked: false,
        content: [
          { type: "text", text: "Ship " },
          { type: "checkbox", checked: true },
        ],
      },
    ]);
  });

  it("spells `checked` out when a model does, and believes it", () => {
    expect(parse('<p><nt-check checked="false"></nt-check></p>')[0]).toMatchObject({
      content: [{ type: "checkbox", checked: false }],
    });
    expect(parse('<p><nt-check checked="true"></nt-check></p>')[0]).toMatchObject({
      content: [{ type: "checkbox", checked: true }],
    });
  });

  it("serializes the editor's own inline content, not only parsed runs", () => {
    expect(
      runsToHtml([
        { type: "text", text: "Day 1 ", styles: {} },
        { type: "checkbox", props: { checked: true } },
        { type: "checkbox", props: { checked: false } },
      ]),
    ).toBe("Day 1 <nt-check checked></nt-check><nt-check></nt-check>");
  });

  it("compiles a ticked box into a setTableRows the applier can run", () => {
    // The whole point of the feature, end to end: the model ticks day one's
    // water box, and what comes out is an op against the table it addressed.
    const current = parse(
      '<table id="t1"><tr><th>Day</th><th>Water</th></tr><tr><td>1</td><td><nt-check></nt-check></td></tr></table>',
    );
    const { ops } = compileDocHtml(
      parse(
        '<table id="t1"><tr><th>Day</th><th>Water</th></tr><tr><td>1</td><td><nt-check checked></nt-check></td></tr></table>',
      ),
      { current },
    );
    expect(ops).toEqual([
      {
        kind: "setTableRows",
        blockId: "t1",
        headerRows: 1,
        rows: [
          [[{ type: "text", text: "Day" }], [{ type: "text", text: "Water" }]],
          [[{ type: "text", text: "1" }], [{ type: "checkbox", checked: true }]],
        ],
      },
    ]);
  });
});
