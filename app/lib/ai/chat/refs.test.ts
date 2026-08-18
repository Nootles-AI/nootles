import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { expandRefs } from "./clientTools";
import { stripDrawings } from "./transcript";

/**
 * The seam that keeps drawings out of the model's mouth: it writes a name, the
 * browser redeems it. Held to the two things that make it safe — it must not
 * disturb anything else in the edit, and a name with nothing behind it must be
 * reported rather than quietly dropped.
 */
const DRAWING = `<nt-diagram w="320" h="180">\n  <nt-rect id="a" x="0" y="0" w="10" h="10"></nt-rect>\n</nt-diagram>`;
const drawings = new Map([["d4a91c", DRAWING]]);

describe("expandRefs", () => {
  it("redeems a ref for its drawing", () => {
    const { html, missing } = expandRefs(
      `<nt-shot><nt-diagram ref="d4a91c"></nt-diagram><nt-note>Dawn</nt-note></nt-shot>`,
      drawings,
    );
    expect(missing).toEqual([]);
    expect(html).toContain('<nt-rect id="a"');
    expect(html).toContain("<nt-note>Dawn</nt-note>");
    expect(html).not.toContain("ref=");
  });

  it("redeems every shot of a board independently", () => {
    const two = new Map([
      ["d1", DRAWING],
      ["d2", DRAWING.replace('id="a"', 'id="b"')],
    ]);
    const { html, missing } = expandRefs(
      `<nt-storyboard ratio="16:9">` +
        `<nt-shot><nt-diagram ref="d1"></nt-diagram><nt-note>One</nt-note></nt-shot>` +
        `<nt-shot><nt-diagram ref="d2"></nt-diagram><nt-note>Two</nt-note></nt-shot>` +
        `</nt-storyboard>`,
      two,
    );
    expect(missing).toEqual([]);
    expect(html).toContain('id="a"');
    expect(html).toContain('id="b"');
  });

  it("names a ref it cannot redeem, and leaves it standing", () => {
    const { html, missing } = expandRefs(
      `<nt-diagram ref="nope"></nt-diagram>`,
      drawings,
    );
    expect(missing).toEqual(["nope"]);
    expect(html).toContain('ref="nope"');
  });

  it("leaves a drawing the model wrote out in full alone", () => {
    const { html, missing } = expandRefs(DRAWING, drawings);
    expect(missing).toEqual([]);
    expect(html).toBe(DRAWING);
  });

  it("does not touch code blocks, whose contents are not markup", () => {
    // This runs BEFORE the raw-text lift in `parseDocHtml`, so anything that
    // reached for a DOM here would mangle exactly what that pass protects.
    const code = `<nt-code-block lang="tsx">const a = <T,>(x: T) => x;\nif (a < b) {}</nt-code-block>`;
    const { html } = expandRefs(`${code}<nt-diagram ref="d4a91c"></nt-diagram>`, drawings);
    expect(html).toContain(code);
    expect(html).toContain('<nt-rect id="a"');
  });
});

describe("stripDrawings", () => {
  const drawResult = (value: {
    ref: string;
    shapes: number;
    html?: string;
  }): ModelMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "draw",
        output: { type: "json", value },
      },
    ],
  });

  it("takes the markup out of what the model reads, keeping the name", () => {
    const [message] = stripDrawings([
      drawResult({ ref: "d1", shapes: 24, html: DRAWING }),
    ]);
    const out = (message.content as { output: { value: Record<string, unknown> } }[])[0].output.value;
    expect(out).toEqual({ ref: "d1", shapes: 24 });
    expect(JSON.stringify(message)).not.toContain("nt-rect");
  });

  it("leaves every other tool's result alone", () => {
    const read: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c2",
          toolName: "read_page",
          output: { type: "text", value: "<title>A page</title>" },
        },
      ],
    };
    expect(stripDrawings([read])[0]).toBe(read);
  });
});
