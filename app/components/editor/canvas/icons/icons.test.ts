import { beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { parseScene } from "../scene/parse";
import { serializeScene } from "../scene/serialize";
import { pathDataBounds } from "../scene/path";
import type { PathNode } from "../scene/types";
import { iconFor, loadIconCatalog } from "./registry";
import { ICON_GROUPS } from "./names";
import { ICON_CATALOG } from "./catalog";

const dom = (html: string) => parseHTML(html).document as unknown as Document;
const parse = (html: string) => parseScene(html, dom);

/** The first (and only) node of a one-element diagram, as the path it became. */
const only = (html: string): PathNode => {
  const scene = parse(`<nt-diagram w="600" h="400">${html}</nt-diagram>`);
  expect(scene.nodes).toHaveLength(1);
  expect(scene.nodes[0].kind).toBe("path");
  return scene.nodes[0] as PathNode;
};

beforeAll(() => loadIconCatalog());

describe("icon expansion", () => {
  it("every listed name resolves, and nothing unlisted is listed", () => {
    // The grammar's list and the parser's catalog are one artifact; a name in
    // one but not the other would be a placeholder box on a user's canvas.
    const listed = ICON_GROUPS.flatMap((g) => [...g.fill, ...g.stroke]);
    for (const name of listed) expect(iconFor(name), name).not.toBeNull();
    expect(listed.length).toBe(Object.keys(ICON_CATALOG).length);
  });

  it("lands as a real path scaled to its box", () => {
    const node = only(
      '<nt-icon name="cat" x="40" y="80" w="48" h="48" style="fill: #8a7564"></nt-icon>',
    );
    expect(node.x).toBe(40);
    expect(node.w).toBe(48);
    expect(node.style.fill).toBe("#8a7564");
    expect(node.attrs["data-icon"]).toBe("cat");
    expect(node.name).toBe("cat");
    const bounds = pathDataBounds(node.d);
    expect(bounds).not.toBeNull();
    // Scaled INTO the box: the glyph's geometry fits 48x48, give or take the
    // source glyph's own padding.
    expect(bounds!.x + bounds!.w).toBeLessThanOrEqual(48.5);
    expect(bounds!.y + bounds!.h).toBeLessThanOrEqual(48.5);
    expect(bounds!.w).toBeGreaterThan(20);
  });

  it("paints silhouettes with a default fill and line icons with a stroke", () => {
    const cat = only('<nt-icon name="cat" x="0" y="0" w="48" h="48"></nt-icon>');
    expect(cat.style.fill).toBe("#2b2b28");
    expect(cat.style.stroke).toBeUndefined();

    const outline = only(
      '<nt-icon name="cat-outline" x="0" y="0" w="48" h="48"></nt-icon>',
    );
    expect(outline.style.fill).toBe("none");
    expect(outline.style.stroke).toBe("#2b2b28");
  });

  it("draws a visible placeholder for a name the catalog lacks", () => {
    const node = only(
      '<nt-icon name="no-such-glyph" x="10" y="10" w="40" h="40"></nt-icon>',
    );
    expect(node.d).toContain("M 0 0");
    expect(node.attrs["data-icon"]).toBe("no-such-glyph");
    expect(node.style.stroke).toBe("#2b2b28");
  });

  it("sizes a box the model omitted from the glyph's own proportions", () => {
    const node = only('<nt-icon name="person-walking"></nt-icon>');
    expect(node.w).toBeGreaterThan(0);
    expect(node.h).toBeGreaterThan(0);
  });

  it("round-trips as the path it became, provenance and all", () => {
    const scene = parse(
      `<nt-diagram w="600" h="400"><nt-icon name="tree" x="20" y="30" w="60" h="60" style="fill: #4c6b52"></nt-icon></nt-diagram>`,
    );
    const html = serializeScene(scene);
    expect(html).toContain('data-icon="tree"');
    expect(html).not.toContain("nt-icon ");
    // Canonical now: the expanded document is stable through the round trip.
    expect(serializeScene(parse(html))).toBe(html);
  });
});
