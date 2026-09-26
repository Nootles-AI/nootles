import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { compileDocHtml } from "./compile";
import { parseDocHtml, type Dropped } from "./parse";
import { notWritten } from "../chat/notWritten";

const dom = (html: string) => parseHTML(html).document as unknown as Document;

/** Parsed as `edit_page` parses a model's HTML. */
function written(html: string) {
  const dropped: Dropped[] = [];
  const nodes = parseDocHtml(html, dom, { dropped, wrapLoose: true });
  return { nodes, dropped };
}

const CURRENT = parseDocHtml('<p id="p1">Intro</p><h2 id="h1">Plan</h2>', dom);

/**
 * NT-95: what the model writes and the page cannot hold is no longer lost
 * without a word. Before, `elementsToNodes` walked element children only and
 * skipped every element it had no block for, so an edit made wholly of such
 * things compiled to an empty batch and `edit_page` answered "the page already
 * reads that way".
 */
describe("HTML an edit cannot make blocks of", () => {
  it("reads words standing between blocks as a paragraph", () => {
    const { nodes, dropped } = written("Next steps: ship <strong>Friday</strong>.\n<p>After</p>");
    expect(dropped).toEqual([]);
    expect(nodes).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Next steps: ship " },
          { type: "text", text: "Friday", marks: ["bold"] },
          { type: "text", text: "." },
        ],
      },
      { type: "paragraph", id: undefined, content: [{ type: "text", text: "After" }] },
    ]);
    const batch = compileDocHtml(nodes, { current: CURRENT, anchorBlockId: "h1" });
    expect(batch.ops.length).toBeGreaterThan(0);
  });

  it("reads a paragraph wrapped in <span> as that paragraph", () => {
    const { nodes, dropped } = written('<span>Owner: <a href="https://x.dev">Ana</a></span>');
    expect(dropped).toEqual([]);
    expect(nodes).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Owner: " },
          { type: "link", href: "https://x.dev", content: [{ type: "text", text: "Ana" }] },
        ],
      },
    ]);
  });

  it("splits loose lines at <br>, and a line break alone makes nothing", () => {
    const { nodes, dropped } = written("one<br>two<br><br>");
    expect(dropped).toEqual([]);
    expect(nodes.map((n) => ("content" in n ? n.content : null))).toEqual([
      [{ type: "text", text: "one" }],
      [{ type: "text", text: "two" }],
    ]);
  });

  it("wraps loose words inside a list container and a toggle", () => {
    const { nodes } = written("<details><summary>More</summary>hidden words</details>");
    expect(nodes).toEqual([
      {
        type: "toggleListItem",
        id: undefined,
        content: [{ type: "text", text: "More" }],
        children: [{ type: "paragraph", content: [{ type: "text", text: "hidden words" }] }],
      },
    ]);
  });

  it("reports an element no block is made of, by the words it held", () => {
    const { nodes, dropped } = written(
      '<figure><img alt="x"><figcaption>Team photo at the offsite, all twelve of us</figcaption></figure><p>kept</p>',
    );
    expect(nodes).toHaveLength(1);
    expect(dropped).toEqual([
      { tag: "figure", text: "Team photo at the offsite, all twelve of…" },
    ]);
  });

  it("reports rather than duplicates words given a block's id on a non-block", () => {
    const { nodes, dropped } = written('<span id="p1">Intro, rewritten</span><div id="h1">New plan</div>');
    expect(nodes).toEqual([]);
    expect(dropped).toEqual([
      { tag: "span", id: "p1", text: "Intro, rewritten" },
      { tag: "div", id: "h1", text: "New plan", loose: true },
    ]);
  });

  it("reports a stray shot, an unsourced picture and an empty table", () => {
    const { dropped } = written("<nt-shot><nt-note>Wide</nt-note></nt-shot><img><table></table>");
    expect(dropped.map((d) => d.tag)).toEqual(["nt-shot", "img", "table"]);
  });

  it("changes nothing for a parse that asks for neither", () => {
    // The completion lanes and the page's own projection parse without options:
    // a stray run there is a block still streaming, and must stay unread.
    expect(parseDocHtml("loose <b>words</b><p>x</p><span>more</span>", dom)).toEqual([
      { type: "paragraph", id: undefined, content: [{ type: "text", text: "x" }] },
    ]);
  });
});

describe("what edit_page says it left out", () => {
  const says = (html: string, title = "Plan") => notWritten(written(html).dropped, title);

  it("says nothing when everything was written", () => {
    expect(says("loose words<p>x</p>")).toBeNull();
  });

  it("stays quiet about the echoes every read carries", () => {
    expect(says('<title>Plan</title><nt-block id="b9">embed</nt-block>')).toBeNull();
  });

  it("names each part it left out and what would have worked", () => {
    expect(
      says(
        '<title>Launch plan</title><figure>Team photo</figure><span id="p1">Intro</span><img><nt-note>Wide</nt-note><aside>Aside text</aside>',
      ),
    ).toBe(
      [
        '- a <title> ("Launch plan"): edit_page does not rename the page — call rename_page for that.',
        '- a <figure> ("Team photo"): not a block — write the picture as <img src="…" alt="caption"> on its own.',
        '- a <span id="p1"> ("Intro"): an id belongs on the block itself — write it as <p id="p1">, <h2 id="p1">… whichever it is.',
        "- an <img> with no src: a new one needs its source.",
        '- an <nt-note> ("Wide") outside a storyboard: a shot goes inside <nt-storyboard>.',
        '- an <aside> ("Aside text"): not something a page can hold — write it as <p>, a heading, a list or a table.',
      ].join("\n"),
    );
  });
});
