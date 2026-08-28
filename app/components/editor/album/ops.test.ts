import { describe, expect, it } from "vitest";
import { handlesFor } from "./handle";
import { applyAlbumOps } from "./ops";
import { columnsFor, layout } from "./waterfall";
import type { Album, AlbumItem } from "./types";

const photo = (n: number, span?: number): AlbumItem => ({
  kind: "image",
  src: `https://store.example/api/storage/photo-${n}`,
  w: 1600,
  h: 1200,
  ...(span ? { span } : {}),
});

const album = (count: number, rest: Partial<Album> = {}): Album => ({
  items: Array.from({ length: count }, (_, i) => photo(i)),
  ...rest,
});

describe("handles", () => {
  it("names a picture by the picture, so a reorder does not rename it", () => {
    const items = [photo(1), photo(2), photo(3)];
    const before = handlesFor(items);
    const after = handlesFor([items[2], items[0], items[1]]);
    expect(after).toEqual([before[2], before[0], before[1]]);
  });

  it("separates the one thing a source cannot — the same picture twice", () => {
    const twice = handlesFor([photo(1), photo(1)]);
    expect(twice[0]).not.toBe(twice[1]);
    expect(new Set(handlesFor(album(60).items)).size).toBe(60);
  });
});

describe("album ops", () => {
  it("reorders by handle, and a partial list promotes rather than deletes", () => {
    const board = album(4);
    const h = handlesFor(board.items);
    const { album: next, missing } = applyAlbumOps(board, [
      { op: "order", items: [h[3], h[1]] },
    ]);
    expect(missing).toEqual([]);
    expect(handlesFor(next.items)).toEqual([h[3], h[1], h[0], h[2]]);
  });

  it("reports a handle nothing answers to instead of touching the wrong picture", () => {
    const board = album(3);
    const { album: next, missing } = applyAlbumOps(board, [
      { op: "remove", items: ["nope"] },
    ]);
    expect(missing).toEqual(["nope"]);
    expect(next.items).toHaveLength(3);
  });

  it("survives the album moving under it between read and apply", () => {
    const board = album(4);
    const h = handlesFor(board.items);
    // The agent read the album, then the user dragged the last picture first.
    const dragged = { ...board, items: [board.items[3], ...board.items.slice(0, 3)] };
    const { album: next } = applyAlbumOps(dragged, [{ op: "remove", items: [h[0]] }]);
    // The picture it named is gone; the drag it never saw is intact.
    expect(handlesFor(next.items)).toEqual([h[3], h[1], h[2]]);
  });

  it("writes a cleared column count and width by omission", () => {
    const pinned = album(3, { cols: 2, w: 900 });
    expect(applyAlbumOps(pinned, [{ op: "grid", cols: null }]).album.cols).toBeUndefined();
    expect(applyAlbumOps(pinned, [{ op: "grid", cols: null }]).album.w).toBe(900);
    const bare = applyAlbumOps(pinned, [{ op: "grid", cols: null, width: null }]).album;
    expect(bare.w).toBeUndefined();
    expect(bare.cols).toBeUndefined();
  });

  it("applies a batch in the order it is written", () => {
    const board = album(3);
    const h = handlesFor(board.items);
    const { album: next } = applyAlbumOps(board, [
      { op: "remove", items: [h[1]] },
      { op: "order", items: [h[2], h[0]] },
      { op: "span", item: h[2], cols: 2 },
      { op: "grid", cols: 4 },
    ]);
    expect(handlesFor(next.items)).toEqual([h[2], h[0]]);
    expect(next.items[0].span).toBe(2);
    expect(next.cols).toBe(4);
  });

  it("keeps what a re-cut picture was cut from, through every later cut", () => {
    const board = album(1);
    const h = handlesFor(board.items);
    const origin = board.items[0];
    const once = applyAlbumOps(board, [
      { op: "replace", item: h[0], with: { ...photo(9), w: 800, h: 600 } },
    ]).album;
    expect(once.items[0].of?.src).toBe(origin.src);

    const twice = applyAlbumOps(once, [
      { op: "replace", item: handlesFor(once.items)[0], with: photo(10) },
    ]).album;
    // The ORIGINAL, not the intermediate crop — reset means the whole picture.
    expect(twice.items[0].of?.src).toBe(origin.src);
  });
});

describe("prominence is position and span, and nothing else", () => {
  /**
   * The arrangement the prompt promises: in a four-column album, the second
   * picture at span 2 takes the two middle columns of the top row. If the
   * packer's tie-break ever changes, that instruction becomes a lie — so it is
   * asserted here rather than trusted.
   */
  it("puts a span-2 picture at index 1 dead centre of a four-column top row", () => {
    const items = [photo(0), photo(1, 2), photo(2), photo(3)];
    const width = 812;
    const columns = columnsFor(width, items, 4);
    expect(columns).toBe(4);

    const { boxes } = layout(items, width, columns);
    const colW = (width - 8 * 3) / 4;
    expect(boxes[1].y).toBe(0);
    expect(boxes[1].x).toBeCloseTo(colW + 8, 5);
    expect(boxes[1].w).toBeCloseTo(colW * 2 + 8, 5);
  });
});
