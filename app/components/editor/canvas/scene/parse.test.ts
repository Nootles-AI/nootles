import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { parseFragment, parseScene, STUB_ATTRS, type ParseHtml } from "./parse";

const parseHtml: ParseHtml = (h) => parseHTML(h).document as unknown as Document;

/**
 * `parseFragment`/`STUB_ATTRS` (TOOLS.md §4.4) — added for `write_nodes`,
 * which has to tell an authored id apart from a minted one and strip stub
 * vocabulary (`at`/`holds`/`text`/`drawn`/`ref`) off an echoed stub without
 * touching a real diagram's own root attributes. `parseScene`'s existing
 * round-trip behaviour is unaffected and covered elsewhere (`toHtml.test.ts`).
 */
describe("parseFragment", () => {
  it("reports authored ids and mints the rest", () => {
    const frag = parseFragment('<nt-diagram><nt-rect id="s1"></nt-rect><nt-rect></nt-rect></nt-diagram>', parseHtml);
    expect(frag.authored.has("s1")).toBe(true);
    expect(frag.scene.nodes[0].id).toBe("s1");
    expect(frag.authored.has(frag.scene.nodes[1].id)).toBe(false);
  });

  it("bare shapes report rootSized:false and empty rootAttrs", () => {
    const frag = parseFragment('<nt-rect id="s1" x="0" y="0" w="10" h="10"></nt-rect>', parseHtml);
    expect(frag.rootSized).toBe(false);
    expect(frag.rootAttrs).toEqual({});
  });

  it("strips stub vocabulary from rootAttrs — parses the literal W17 markup", () => {
    const frag = parseFragment(
      '<nt-diagram id="b7" at="b7" holds="7 shapes" text="…"><nt-rect w="10" h="10"></nt-rect></nt-diagram>',
      parseHtml,
    );
    expect(frag.rootAttrs).toEqual({});
    for (const key of STUB_ATTRS) expect(frag.rootAttrs[key]).toBeUndefined();
  });

  it("a genuine custom root attribute survives", () => {
    const frag = parseFragment('<nt-diagram data-foo="bar"><nt-rect w="10" h="10"></nt-rect></nt-diagram>', parseHtml);
    expect(frag.rootAttrs).toEqual({ "data-foo": "bar" });
  });

  it("a wrapper that states both w and h is rootSized", () => {
    const frag = parseFragment('<nt-diagram w="600" h="400"></nt-diagram>', parseHtml);
    expect(frag.rootSized).toBe(true);
    expect(frag.scene.w).toBe(600);
    expect(frag.scene.h).toBe(400);
  });

  it("parseScene(html) deep-equals parseFragment(html).scene", () => {
    const html = '<nt-diagram w="10" h="10"><nt-rect id="s1" x="0" y="0" w="5" h="5"></nt-rect></nt-diagram>';
    expect(parseScene(html, parseHtml)).toEqual(parseFragment(html, parseHtml).scene);
  });

  it("parseScene's own .attrs is unstripped", () => {
    const html = '<nt-diagram id="b7" at="b7" holds="7 shapes" text="…"><nt-rect w="10" h="10"></nt-rect></nt-diagram>';
    const scene = parseScene(html, parseHtml);
    expect(scene.attrs).toEqual({ at: "b7", holds: "7 shapes", text: "…" });
  });
});
