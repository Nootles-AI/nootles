import { describe, expect, it } from "vitest";
import { filterItems, type RankedItem } from "./slashRank";

// The slash menu's own entries where the ranking decides between them
// (`Editor.tsx`'s `slashItems`), in the menu's order.
const ITEMS: RankedItem[] = [
  { title: "Text", aliases: ["paragraph", "p"], group: "Write" },
  { title: "Diagram", aliases: ["diagram", "canvas", "draw", "flowchart", "board", "graph"], group: "Insert" },
  { title: "Wide canvas", aliases: ["wide", "wide canvas", "wide diagram", "wide board", "widecanvas"], group: "Insert" },
  { title: "Storyboard", aliases: ["storyboard", "board", "shots", "frames", "panels", "scene"], group: "Insert" },
  { title: "Media", aliases: ["media", "audio", "video", "song"], group: "Insert" },
  { title: "Album", aliases: ["album", "photos", "gallery", "video", "media"], group: "Insert" },
];

const titles = (query: string) => filterItems(ITEMS, query).map((item) => item.title);

describe("slash menu ranking", () => {
  it("puts the plain diagram first for what people call one", () => {
    for (const query of ["canvas", "Canvas ", "can", "diagram", "diag", "draw", "board"]) {
      expect(titles(query)[0], query).toBe("Diagram");
    }
  });

  it("still offers the wide canvas, after the diagram", () => {
    const found = titles("canvas");
    expect(found).toEqual(["Diagram", "Wide canvas"]);
    expect(titles("diagram")).toEqual(["Diagram", "Wide canvas"]);
  });

  it("puts the wide canvas first only when asked for wide", () => {
    for (const query of ["wide", "wid", "wide c", "wide canvas", "widecanvas"]) {
      expect(titles(query)[0], query).toBe("Wide canvas");
    }
  });

  it("lands on the item named what was typed before one that answers to it", () => {
    expect(titles("media")).toEqual(["Media", "Album"]);
    expect(titles("album")[0]).toBe("Album");
  });

  it("keeps everything, in order, for an empty query", () => {
    expect(filterItems(ITEMS, "  ")).toBe(ITEMS);
  });

  it("keeps each group one run, ranked by its best item", () => {
    const found = filterItems(ITEMS, "p").map((item) => item.group);
    expect(found).toEqual([...found].sort((a, b) => found.indexOf(a!) - found.indexOf(b!)));
    expect(filterItems(ITEMS, "p")[0].title).toBe("Text");
  });
});
