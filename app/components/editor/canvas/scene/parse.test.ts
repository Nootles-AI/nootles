import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { materializeCanvas, populateCanvas } from "../collab/ymap";
import { migrateLegacyCanvas, readCanvasSource } from "./migrate";
import { parseFragment, parseScene, STUB_ATTRS, type ParseHtml } from "./parse";
import { serializeScene } from "./serialize";

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

  it("bare shapes report rootH:false and empty rootAttrs", () => {
    const frag = parseFragment('<nt-rect id="s1" x="0" y="0" w="10" h="10"></nt-rect>', parseHtml);
    expect(frag.rootH).toBe(false);
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

  it("a wrapper that states h is rootH, with or without a width", () => {
    const frag = parseFragment('<nt-diagram w="600" h="400"></nt-diagram>', parseHtml);
    expect(frag.rootH).toBe(true);
    expect(frag.scene.w).toBe(600);
    expect(frag.scene.h).toBe(400);
    expect(parseFragment('<nt-diagram h="96"></nt-diagram>', parseHtml).rootH).toBe(true);
    expect(parseFragment('<nt-diagram w="720"></nt-diagram>', parseHtml).rootH).toBe(false);
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

/**
 * The root after bands: a diagram states `h` and, when wide, a bare `wide`,
 * and no width; a storyboard frame keeps its `w`. Parse stays raw — an old
 * root becomes a band through `migrateLegacyCanvas`, never through parse.
 */
describe("the root", () => {
  const RECT = `  <nt-rect id="a" x="40" y="24" w="160" h="72"></nt-rect>`;
  const CANONICAL = [
    `<nt-diagram h="312">\n${RECT}\n</nt-diagram>`,
    `<nt-diagram h="312" wide>\n${RECT}\n</nt-diagram>`,
    `<nt-diagram id="d1" h="312" wide data-legacy-edges="[]" style="background: #fff">\n${RECT}\n</nt-diagram>`,
    `<nt-diagram h="74"></nt-diagram>`,
    // A storyboard shot, byte for byte.
    `<nt-diagram w="320" h="180">\n${RECT}\n</nt-diagram>`,
    // An old root, read raw.
    `<nt-diagram w="960" h="540" data-height="fixed" data-width="fixed">\n${RECT}\n</nt-diagram>`,
  ];

  it("round-trips byte for byte, and through the maps", () => {
    for (const html of CANONICAL) {
      const scene = parseScene(html, parseHtml);
      expect(serializeScene(scene)).toBe(html);
      const root = new Y.Doc().getMap<unknown>("canvas:b1");
      populateCanvas(root, scene);
      expect(materializeCanvas(root)).toEqual(scene);
    }
  });

  it("reads wide as a flag, writes it bare, and never carries it in attrs", () => {
    for (const spelling of [`wide`, `wide=""`, `wide="true"`]) {
      const frag = parseFragment(`<nt-diagram h="96" ${spelling} data-foo="bar"></nt-diagram>`, parseHtml);
      expect(frag.scene.wide).toBe(true);
      expect(frag.scene.attrs).toEqual({ "data-foo": "bar" });
      expect(frag.rootAttrs).toEqual({ "data-foo": "bar" });
      expect(serializeScene(frag.scene)).toBe(`<nt-diagram h="96" wide data-foo="bar"></nt-diagram>`);
    }
    for (const spelling of [`wide="false"`, `wide="0"`]) {
      const frag = parseFragment(`<nt-diagram h="96" ${spelling}></nt-diagram>`, parseHtml);
      expect("wide" in frag.scene).toBe(false);
      expect(frag.scene.attrs).toEqual({});
    }
    const narrow = parseScene(`<nt-diagram h="96"></nt-diagram>`, parseHtml);
    expect("wide" in narrow).toBe(false);
    // Even a scene that somehow holds one in attrs does not write it twice.
    expect(serializeScene({ ...narrow, attrs: { wide: "" } })).toBe(`<nt-diagram h="96"></nt-diagram>`);
  });

  it("a shape's own wide is just an attribute", () => {
    const scene = parseScene(`<nt-diagram h="96"><nt-rect id="a" w="10" h="10" wide></nt-rect></nt-diagram>`, parseHtml);
    expect(scene.nodes[0].attrs).toEqual({ wide: "" });
  });

  it("parse never derives a width", () => {
    expect(parseScene(`<nt-diagram h="312" wide></nt-diagram>`, parseHtml).w).toBe(0);
    expect(parseScene(`<nt-diagram w="960" h="540"></nt-diagram>`, parseHtml).w).toBe(960);
  });

  it("an old root reads as the band it becomes, and a frame's reader leaves it as written", () => {
    const oldRoot = `<nt-diagram w="960" h="540" data-height="fixed">\n${RECT}\n</nt-diagram>`;
    expect(serializeScene(migrateLegacyCanvas(oldRoot, parseHtml))).toBe(
      `<nt-diagram h="540">\n${RECT}\n</nt-diagram>`,
    );
    const widened = `<nt-diagram w="1100" h="300" data-width="fixed">\n${RECT}\n</nt-diagram>`;
    expect(serializeScene(migrateLegacyCanvas(widened, parseHtml))).toBe(
      `<nt-diagram h="260" wide>\n${RECT}\n</nt-diagram>`,
    );
    const shot = CANONICAL[4];
    expect(serializeScene(readCanvasSource(shot, parseHtml))).toBe(shot);
    // Read as a diagram, a band root is already what it reads as.
    expect(serializeScene(migrateLegacyCanvas(CANONICAL[1], parseHtml))).toBe(CANONICAL[1]);
  });
});
