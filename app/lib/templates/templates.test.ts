import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOMParser as LinkedomParser, parseHTML } from "linkedom";
import { parseAlbum } from "@/app/components/editor/album/parse";
import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { fitToBand } from "@/app/components/editor/canvas/scene/band";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { parseLocation } from "@/app/components/editor/location/parse";
import { serializeLocation } from "@/app/components/editor/location/serialize";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import { PROJECT_TEMPLATES, pagePicture, pagesOf } from ".";
import { seedOf } from "./seed";

const dom = (html: string) => parseHTML(html).document as unknown as Document;

// Seeding reads each diagram into its band on the way into the document, with
// the browser's DOMParser — which this runtime does not have.
const native = globalThis.DOMParser;
beforeAll(() => {
  if (typeof native !== "function") globalThis.DOMParser = LinkedomParser as unknown as typeof DOMParser;
});
afterAll(() => {
  globalThis.DOMParser = native;
});

/** Each rich block's stored markup, and the form its own reader and writer give back. */
const CANONICAL: Record<string, (data: string) => string> = {
  canvas: (data) => serializeScene(parseScene(data, dom)),
  album: (data) => serializeAlbum(parseAlbum(data, dom)),
  storyboard: (data) => serializeStoryboard(parseStoryboard(data, dom)),
  location: (data) => serializeLocation(parseLocation(data, dom)),
};

/**
 * A template is only worth offering if every page in it becomes a document.
 * `seedOf` stands up the headless editor each page is born from, so a block the
 * schema rejects fails here rather than at the moment someone picks the
 * template.
 */
describe.each(PROJECT_TEMPLATES)("the $name template", (template) => {
  it("compiles every page to a document, in the shape projects.create takes", () => {
    const seed = seedOf(template);
    expect(seed.map((row) => row.kind)).toEqual(template.rows.map((row) => row.kind));
    const born = seed.flatMap((row) => (row.kind === "page" ? [row] : row.pages));
    expect(born.map((p) => p.title)).toEqual(pagesOf(template).map((p) => p.title));
    for (const page of born) expect(page.update.byteLength, page.title).toBeGreaterThan(0);
  });

  it("names every page, uniquely — the preview's file list keys on the title", () => {
    const titles = pagesOf(template).map((p) => p.title);
    expect(titles.every(Boolean)).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("seeds every map, album, board and diagram in the form its block writes", () => {
    for (const page of pagesOf(template)) {
      for (const block of page.blocks) {
        const canonical = CANONICAL[String(block.type)];
        if (!canonical) continue;
        const data = String((block.props as { data?: string }).data);
        expect(canonical(data), `${page.title}: ${block.type}`).toBe(data);
      }
    }
  });

  it("seeds diagrams that are already bands — nothing for the reader or a fit to move", () => {
    for (const page of pagesOf(template)) {
      for (const block of page.blocks) {
        if (block.type !== "canvas") continue;
        const data = String((block.props as { data?: string }).data);
        const scene = migrateLegacyCanvas(data, dom);
        expect(serializeScene(scene), page.title).toBe(data);
        expect(serializeScene(fitToBand(scene)), page.title).toBe(data);
      }
    }
  });

  it("draws every page under its title", () => {
    for (const page of pagesOf(template)) {
      const picture = pagePicture(page);
      expect(picture[0]).toMatchObject({ type: "heading", props: { level: 1 } });
      expect(new Set(picture.map((b) => b.id)).size, page.title).toBe(picture.length);
    }
  });
});

it("PRD is an overview and a spec folder of three", () => {
  const prd = PROJECT_TEMPLATES.find((t) => t.id === "prd")!;
  expect(
    prd.rows.map((row) => (row.kind === "page" ? row.title : [row.title, row.pages.map((p) => p.title)])),
  ).toEqual(["Overview", ["Spec", ["Requirements", "Designs", "Open questions"]]]);
});
