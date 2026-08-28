"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import { handlesFor } from "@/app/components/editor/album/handle";
import { parseAlbum } from "@/app/components/editor/album/parse";
import { contactSheet, SHEET_MAX } from "@/app/components/editor/album/sheet";
import type { AlbumItem } from "@/app/components/editor/album/types";
import type { AnyBlock } from "./projection";

/**
 * An album, as something the agent can reason about instead of look at.
 *
 * One line per picture: its handle, its shape, its colour, how much it carries
 * a wall, and a clause saying what it is. Roughly twenty-five tokens each, and
 * every field is something an op can be decided from — which is the whole
 * contrast with the markup this replaces, where eighty of a picture's hundred
 * characters were a URL the model could not use for anything.
 *
 * The two tiers arrive from different places and at different prices, and the
 * split is deliberate. Colour was measured for free when the photo was uploaded
 * and is simply read back; captions cost one model call for the whole album and
 * are only fetched the first time somebody asks. "Remove the outliers and get a
 * clean monochromatic look" is answered entirely from the free half — the hues
 * are right there — and never sends a picture anywhere.
 */

type Meta = {
  src: string;
  hex: string;
  palette: string[];
  hue: number;
  sat: number;
  light: number;
  energy?: number;
  alt?: string;
  striking?: number;
};

/** Blocks that are albums, by id, from anywhere in the document. */
function albumsIn(blocks: AnyBlock[], out = new Map<string, AlbumItem[]>()) {
  for (const block of blocks) {
    if (block.type === "album") {
      out.set(block.id, parseAlbum(String(block.props.data ?? "")).items);
    }
    if (block.children?.length) albumsIn(block.children, out);
  }
  return out;
}

/**
 * Describes whatever is not described yet, in one call.
 *
 * Only pictures with no caption go on the sheet, so a second question about the
 * same album costs nothing and an album that grew by three photos costs one
 * call about three photos. Past a sheet's worth, the rest are left for a later
 * read rather than fanned out into several calls at once — an agent that has
 * seen two dozen pictures of an album can already answer almost anything about
 * it, and the ones left over say plainly that they are un-described.
 */
async function describeMissing(
  convex: ConvexReactClient,
  items: readonly AlbumItem[],
  handles: readonly string[],
  known: Map<string, Meta>,
): Promise<Map<string, Meta>> {
  const wanted = items
    .map((item, i) => ({ item, handle: handles[i] }))
    .filter(({ item, handle }) => item.kind === "image" && !known.get(handle)?.alt)
    .slice(0, SHEET_MAX);
  if (!wanted.length) return known;

  const sheet = await contactSheet(
    wanted.map(({ item, handle }) => ({
      handle,
      src: item.src,
      measured: known.has(handle),
    })),
  );
  if (!sheet) return known;

  // Colour for anything that never had it — an album from before the upload
  // pass existed, or a picture re-cut in the lightbox. The bytes were decoded
  // to build the sheet, so this half is free and happens whether or not the
  // describing call below succeeds.
  const measured = sheet.tiles.filter(
    (tile): tile is typeof tile & { stats: NonNullable<typeof tile.stats> } =>
      tile.stats !== null,
  );
  if (measured.length) {
    await convex
      .mutation(api.imageMeta.put, {
        entries: measured.map(({ src, stats }) => ({ src, ...stats })),
      })
      .catch(() => {});
    for (const { handle, src, stats } of measured) {
      known.set(handle, { ...(known.get(handle) ?? { src }), src, ...stats });
    }
  }

  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("sheet unreadable"));
    reader.readAsDataURL(sheet.blob);
  });

  const response = await fetch("/api/album/index", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUri, handles: sheet.tiles.map((t) => t.handle) }),
  }).catch(() => null);
  if (!response?.ok) return known;

  const { described } = (await response.json().catch(() => ({ described: [] }))) as {
    described: { handle: string; alt: string; striking: number }[];
  };
  const bySrc = new Map(sheet.tiles.map((tile) => [tile.handle, tile.src]));
  const entries = described
    .filter((row) => bySrc.has(row.handle) && row.alt)
    .map((row) => ({ src: bySrc.get(row.handle)!, alt: row.alt, striking: row.striking }));
  if (!entries.length) return known;

  await convex.mutation(api.imageMeta.describe, { entries }).catch(() => {});
  for (const row of described) {
    const src = bySrc.get(row.handle);
    if (!src || !row.alt) continue;
    known.set(row.handle, {
      ...(known.get(row.handle) ?? {
        src,
        hex: "#808080",
        palette: [],
        hue: 0,
        sat: 0,
        light: 50,
      }),
      alt: row.alt,
      striking: row.striking,
    });
  }
  return known;
}

/** `#2f4858 h205 s34 l26` — the colour, said twice, because both get used. */
function colourOf(meta: Meta | undefined): string {
  if (!meta) return "colour unmeasured";
  return `${meta.hex} h${meta.hue} s${meta.sat} l${meta.light}`;
}

/**
 * The index for the albums the model asked to expand, appended to a page read.
 *
 * Written as plainly not-HTML so that nothing here can be mistaken for markup
 * to echo back: the page's own albums are stubs in the HTML above, and this is
 * the reference the model reads them against.
 */
export async function albumIndex(
  convex: ConvexReactClient,
  blocks: AnyBlock[],
  expand: readonly string[],
): Promise<string> {
  const albums = albumsIn(blocks);
  const wanted = expand.filter((id) => albums.has(id));
  if (!wanted.length) return "";

  const sections: string[] = [];
  for (const blockId of wanted) {
    const items = albums.get(blockId)!;
    if (!items.length) {
      sections.push(`<!-- album ${blockId}: empty -->`);
      continue;
    }
    const handles = handlesFor(items);
    const rows = await convex
      .query(api.imageMeta.read, { srcs: items.map((item) => item.src) })
      .catch(() => [] as Meta[]);
    const bySrc = new Map(rows.map((row) => [row.src, row as Meta]));
    let known = new Map<string, Meta>(
      items.flatMap((item, i) => {
        const meta = bySrc.get(item.src);
        return meta ? [[handles[i], meta] as const] : [];
      }),
    );
    known = await describeMissing(convex, items, handles, known).catch(() => known);

    const lines = items.map((item, i) => {
      const meta = known.get(handles[i]);
      const ratio = `${item.w}:${item.h}`;
      const rank =
        meta?.striking !== undefined
          ? `striking ${meta.striking}`
          : meta?.energy !== undefined
            ? `energy ${meta.energy}`
            : "unranked";
      return [
        handles[i],
        item.kind === "video" ? "video" : ratio,
        colourOf(meta),
        item.span && item.span > 1 ? `span ${item.span}` : "",
        rank,
        meta?.alt ? `"${meta.alt}"` : "undescribed",
      ]
        .filter(Boolean)
        .join(" ");
    });
    sections.push(
      [
        `<!-- album ${blockId}, in the order it reads. Address pictures by the first`,
        `     column, in album_edit. striking/energy are 0-99. -->`,
        ...lines,
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}
