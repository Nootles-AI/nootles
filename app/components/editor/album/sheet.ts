"use client";

import { statsFrom, type ImageStats } from "./stats";

/**
 * An album's pictures, laid out as one labelled grid for a model to look at.
 *
 * This is the whole cost story of letting an agent SEE an album. Twenty-four
 * photographs sent as twenty-four images cost roughly twenty-four times what
 * one 1000×800 sheet costs, for the same information — and the sheet keeps the
 * one thing a screenshot of the rendered waterfall would have thrown away,
 * which is the ability to say WHICH picture. Each tile is stamped with the
 * handle the agent addresses it by, so what comes back can be filed against
 * `imageMeta` and used in an `album_edit` op.
 *
 * It is not a picture of the album. The waterfall's own arrangement is
 * irrelevant here and would only waste tiles on the gaps; this is a plain grid
 * of equal cells, packed for legibility.
 *
 * Every picture is decoded on the way past, so the free colour tier is measured
 * for anything that never had it — an album uploaded before that pass existed,
 * or a picture re-cut in the lightbox. Backfilling here costs nothing: the
 * bytes are already decoded and the canvas is already open.
 */

/** The side of one cell. Large enough to read a subject, small enough to be cheap. */
const CELL = 200;
/** Around each cell, so a stamped handle sits on the sheet and not on a photo. */
const PAD = 6;
const LABEL = 15;
/** Never more in one sheet. Past this the tiles are too small to be worth looking at. */
export const SHEET_MAX = 24;

export type SheetTile = {
  handle: string;
  src: string;
  /** Measured on the way past — present only for a picture that had no row. */
  stats: ImageStats | null;
};

export type ContactSheet = {
  blob: Blob;
  w: number;
  h: number;
  /** Only the pictures that actually made it onto the sheet, in reading order. */
  tiles: SheetTile[];
};

/**
 * Fetched, not `<img src>`: a fetched blob decodes into an untainted bitmap,
 * where an element loaded cross-origin taints the canvas and makes the sheet
 * unreadable at the moment we try to export it. Same door the lightbox's crop
 * goes through.
 */
async function bitmapOf(src: string): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

export async function contactSheet(
  pictures: readonly { handle: string; src: string; measured: boolean }[],
): Promise<ContactSheet | null> {
  const wanted = pictures.slice(0, SHEET_MAX);
  if (!wanted.length) return null;

  const loaded = await Promise.all(
    wanted.map(async (picture) => ({ ...picture, bitmap: await bitmapOf(picture.src) })),
  );
  const drawable = loaded.filter(
    (picture): picture is typeof picture & { bitmap: ImageBitmap } => picture.bitmap !== null,
  );
  if (!drawable.length) return null;

  const columns = Math.ceil(Math.sqrt(drawable.length));
  const rows = Math.ceil(drawable.length / columns);
  const step = CELL + PAD * 2;
  const canvas = document.createElement("canvas");
  canvas.width = columns * step;
  canvas.height = rows * step;
  const context = canvas.getContext("2d");
  if (!context) {
    for (const picture of drawable) picture.bitmap.close();
    return null;
  }

  // A flat mid grey, not white: a photograph with blown highlights and one with
  // a white border are different pictures, and on white they are the same one.
  context.fillStyle = "#8a8a8a";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = "top";
  context.font = `600 ${LABEL - 3}px ui-monospace, monospace`;

  const tiles: SheetTile[] = [];
  drawable.forEach((picture, i) => {
    const x = (i % columns) * step + PAD;
    const y = Math.floor(i / columns) * step + PAD;
    const { bitmap } = picture;

    // Contained, never cropped. A moodboard is half composition, and a square
    // crop of a panorama is a claim about the picture that is not true.
    const scale = Math.min(CELL / bitmap.width, (CELL - LABEL) / bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(
      bitmap,
      x + Math.round((CELL - w) / 2),
      y + LABEL + Math.round((CELL - LABEL - h) / 2),
      w,
      h,
    );

    context.fillStyle = "#000";
    context.fillRect(x, y, CELL, LABEL);
    context.fillStyle = "#fff";
    context.fillText(picture.handle, x + 3, y + 2);

    tiles.push({
      handle: picture.handle,
      src: picture.src,
      stats: picture.measured ? null : statsFrom(bitmap),
    });
    bitmap.close();
  });

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/webp", 0.8);
  });
  return blob ? { blob, w: canvas.width, h: canvas.height, tiles } : null;
}
