import { describe, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { redeemDrawnStubs, toDocHtml } from "./html/serialize";
import type { AnyBlock } from "./projection";

/**
 * The stub's safety property, which is the whole reason albums collapse rather
 * than simply reading shorter.
 *
 * Dropping the storage URLs from what the model reads is only safe if what it
 * reads is not also what it would write back. A stub echoed unchanged has to
 * redeem to the album exactly as it stands — because the compiler diffs against
 * the live document, and an echoed list of pictures with no `src` on them would
 * compile to an album with no pictures in it.
 */

// The album parser reaches for the browser's DOMParser, which is exactly where
// both of these run — the collapse is in a page read and the redemption is in
// `edit_page`, and both live in the browser half of the tool set.
globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

const data = serializeAlbum({
  items: [
    { kind: "image", src: "https://store.example/api/storage/one", w: 1600, h: 1200 },
    { kind: "image", src: "https://store.example/api/storage/two", w: 900, h: 1600, span: 2 },
    {
      kind: "video",
      src: "https://store.example/api/storage/reel",
      w: 1280,
      h: 720,
      poster: "https://store.example/api/storage/poster",
    },
  ],
  cols: 3,
});

const blocks: AnyBlock[] = [
  { id: "b7", type: "album", props: { data }, content: undefined, children: [] },
] as unknown as AnyBlock[];

describe("album stubs", () => {
  it("hides the storage URLs but says what the block holds", () => {
    const html = toDocHtml(blocks, { collapseAlbums: true });
    expect(html).toBe('<nt-album at="b7" holds="2 photos, 1 video" cols="3"></nt-album>');
    expect(html).not.toContain("storage/one");
  });

  it("redeems an echoed stub to the album exactly as it stands", () => {
    const stub = toDocHtml(blocks, { collapseAlbums: true });
    const { html, missing } = redeemDrawnStubs(stub, blocks);
    expect(missing).toEqual([]);
    // Byte-for-byte what the block already holds, id included — so the diff
    // this compiles to is empty and the echo is a no-op.
    expect(html).toBe(serializeAlbum({ ...parsed(), id: "b7" }));
  });

  it("honours a column count changed on the stub, and nothing else", () => {
    const { html } = redeemDrawnStubs(
      '<nt-album at="b7" holds="2 photos, 1 video" cols="4"></nt-album>',
      blocks,
    );
    expect(html).toContain('cols="4"');
    expect(html).toContain("storage/reel");
    expect(html.match(/<img|<video/g)).toHaveLength(3);
  });

  it("says so when the album it stood for is gone", () => {
    const { missing } = redeemDrawnStubs('<nt-album at="gone"></nt-album>', blocks);
    expect(missing).toEqual(["gone"]);
  });
});

/** The stored album, re-read the way the redeemer reads it. */
function parsed() {
  return {
    items: [
      { kind: "image" as const, src: "https://store.example/api/storage/one", w: 1600, h: 1200 },
      {
        kind: "image" as const,
        src: "https://store.example/api/storage/two",
        w: 900,
        h: 1600,
        span: 2,
      },
      {
        kind: "video" as const,
        src: "https://store.example/api/storage/reel",
        w: 1280,
        h: 720,
        poster: "https://store.example/api/storage/poster",
      },
    ],
    cols: 3,
  };
}
