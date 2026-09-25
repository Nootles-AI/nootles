import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseDocHtml } from "./parse";

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const runs = (html: string) => {
  const [block] = parseDocHtml(html, dom) as unknown as { content: unknown[] }[];
  return block.content;
};

/**
 * Inline code excludes every other mark in the editor. Read as written, bolded
 * code was refused at insert — a RangeError that cost a whole page's edit — and
 * an echo of an unchanged block compared as a rewrite. So it is read as the
 * editor will hold it.
 */
describe("marks the editor can hold", () => {
  it("reads bolded or emphasised code as code", () => {
    expect(runs("<p>Call <strong><code>ownerId</code></strong> first.</p>")).toEqual([
      { type: "text", text: "Call " },
      { type: "text", text: "ownerId", marks: ["code"] },
      { type: "text", text: " first." },
    ]);
    expect(runs("<p><code><em>x</em></code></p>")).toEqual([{ type: "text", text: "x", marks: ["code"] }]);
  });

  it("reads code inside a link as the link, keeping other emphasis", () => {
    expect(runs('<p><a href="https://example.com"><strong><code>api</code></strong> docs</a></p>')).toEqual([
      {
        type: "link",
        href: "https://example.com",
        content: [
          { type: "text", text: "api", marks: ["bold"] },
          { type: "text", text: " docs" },
        ],
      },
    ]);
  });

  it("leaves marks that combine alone", () => {
    expect(runs("<p><strong><em>both</em></strong></p>")).toEqual([
      { type: "text", text: "both", marks: ["bold", "italic"] },
    ]);
  });
});

describe("inline maths round-trips", () => {
  it("a formula with < and & survives being read back", async () => {
    const { runsToHtmlFromRuns } = await import("./serialize");
    const html = runsToHtmlFromRuns([{ type: "math", latex: "a<b & c" }] as never);
    expect(html).toBe("<nt-math>a&lt;b &amp; c</nt-math>");
    expect(runs(`<p>${html}</p>`)).toEqual([{ type: "math", latex: "a<b & c" }]);
  });
});

describe("a checklist item", () => {
  it('reads checked="false" as unticked, as a tick box does', () => {
    const [item] = parseDocHtml('<ul><li><input type="checkbox" checked="false">Ship it</li></ul>', dom) as unknown as {
      checked: boolean;
    }[];
    expect(item.checked).toBe(false);
  });
});
