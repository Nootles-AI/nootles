import { describe, expect, it } from "vitest";
import { PROJECT_TEMPLATES, pagePicture, pagesOf } from ".";
import { seedOf } from "./seed";

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

  it("draws every page under its title", () => {
    for (const page of pagesOf(template)) {
      const picture = pagePicture(page);
      expect(picture[0]).toMatchObject({ type: "heading", props: { level: 1 } });
      expect(new Set(picture.map((b) => b.id)).size, page.title).toBe(picture.length);
    }
  });
});

it("PRD is an overview and a spec folder of two", () => {
  const prd = PROJECT_TEMPLATES.find((t) => t.id === "prd")!;
  expect(
    prd.rows.map((row) => (row.kind === "page" ? row.title : [row.title, row.pages.map((p) => p.title)])),
  ).toEqual(["Overview", ["Spec", ["Requirements", "Open questions"]]]);
});
