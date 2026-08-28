"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MAX_VIDEO_BYTES, measureVideo, prepareVideo } from "./video";
import { statsFrom, type ImageStats } from "./stats";
import type { AlbumItem } from "./types";

/**
 * Files on their way into an album.
 *
 * Everything is made smaller before it is uploaded, never after: a photo is
 * redrawn at screen size and re-encoded as WebP, a video goes through ffmpeg
 * (see `video.ts`). What reaches storage is what the page will load, so there
 * is no second, heavier copy of an album sitting behind the one being served.
 *
 * A file is MEASURED before it is processed, and its shape reported straight
 * away. That is what lets the waterfall put a tile down for it immediately, at
 * the exact size the picture will occupy — the album fills in place rather than
 * growing a row of surprises at the end, and the arriving picture replaces its
 * own outline without moving anything.
 *
 * A batch lands IN THE ORDER IT WAS CHOSEN even though the files finish out of
 * order — a small photo behind a long video would otherwise overtake it, and an
 * album that shuffles as it fills is unsettling to watch.
 */

/** Long edge, in pixels: retina-sharp at any width the block can be dragged to. */
const MAX_IMAGE_EDGE = 2560;

/** WebP quality. Visually clean; roughly a sixth of a phone photo's JPEG. */
const IMAGE_QUALITY = 0.82;

/** How many files are worked on at once. Encoding is CPU-bound, not network-bound. */
const LANES = 3;

/**
 * How much of a video's wait is the transcode. The rest is the upload, so one
 * bar can cover both phases without ever going backwards.
 */
const TRANSCODE_SHARE = 0.75;

/**
 * What the picker offers and what the drop zone keeps. HEIC is the notable
 * absence: it is what an iPhone stores by default and what no browser can
 * decode, so it is refused by name below rather than failing as "not an image".
 */
const IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
];

export const ALBUM_ACCEPT = [...IMAGE_TYPES, "video/*"].join(",");

/** A file with a place in the waterfall and nothing in it yet. */
export type Pending = {
  id: string;
  kind: AlbumItem["kind"];
  name: string;
  /** Its true shape, read before any of the work — so the outline is honest. */
  w: number;
  h: number;
  /** 0–1. Reaches 1 when the file is up, which may be before its turn to land. */
  progress: number;
  note: string;
};

export type Handlers = {
  /** A file has been measured: put an outline down for it. */
  onPending: (pending: Pending) => void;
  onAdvance: (id: string, progress: number, note: string) => void;
  /**
   * The picture is up. Its outline can go.
   *
   * `stats` is what the picture looks like, measured off the canvas the
   * re-encode already drew — free, and the whole of what the agent knows about
   * an album's colour. Null where nothing could be measured: an animated GIF
   * passed through untouched, or a video with no poster frame.
   */
  onItem: (id: string, item: AlbumItem, stats: ImageStats | null) => void;
  /** It failed, and its outline should go with it. */
  onDrop: (id: string) => void;
  /** Said in words the uploader can act on. */
  onError: (message: string) => void;
};

/** Files this album can take, and a message naming the ones it cannot. */
export function acceptable(files: File[]): { taken: File[]; refused: string[] } {
  const taken: File[] = [];
  const refused: string[] = [];
  for (const file of files) {
    const name = file.name || "That file";
    if (file.type.startsWith("video/")) {
      if (file.size > MAX_VIDEO_BYTES) {
        refused.push(`${name} is ${megabytes(file.size)} — videos have to be under ${megabytes(MAX_VIDEO_BYTES)}.`);
      } else {
        taken.push(file);
      }
    } else if (IMAGE_TYPES.includes(file.type)) {
      taken.push(file);
    } else if (/\.heic$|\.heif$/i.test(name) || file.type === "image/heic") {
      refused.push(`${name} is a HEIC photo, which browsers can't read. Export it as JPEG first.`);
    } else {
      refused.push(`${name} isn't a photo or a video.`);
    }
  }
  return { taken, refused };
}

/**
 * Compresses and uploads a batch, reporting each file's shape as it is learned
 * and each picture as it lands.
 *
 * Resolves when the batch is finished, whatever happened to it: a file that
 * fails is reported and skipped, because one unreadable photo must not cost the
 * other nineteen.
 */
export async function ingest(
  convex: ConvexReactClient,
  files: File[],
  handlers: Handlers,
): Promise<void> {
  const { taken, refused } = acceptable(files);
  for (const message of refused) handlers.onError(message);
  if (!taken.length) return;

  const ids = taken.map(() => crypto.randomUUID());
  const results = new Array<Prepared | null | undefined>(taken.length);
  let flushed = 0;

  /** Hand over everything now complete from the front of the queue. */
  const flush = () => {
    while (flushed < results.length && results[flushed] !== undefined) {
      const done = results[flushed];
      if (done) handlers.onItem(ids[flushed], done.item, done.stats);
      else handlers.onDrop(ids[flushed]);
      flushed++;
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, taken.length) }, async () => {
      while (next < taken.length) {
        const index = next++;
        const file = taken[index];
        const id = ids[index];
        try {
          results[index] = await prepare(convex, file, {
            measured: (w, h, kind) =>
              handlers.onPending({
                id,
                kind,
                name: file.name || "Untitled",
                w,
                h,
                progress: 0,
                note: "",
              }),
            advance: (progress, note) => handlers.onAdvance(id, progress, note),
          });
        } catch {
          results[index] = null;
          handlers.onError(`${file.name || "A file"} didn't upload. Try adding it again.`);
        }
        flush();
      }
    }),
  );
}

type Hooks = {
  measured: (w: number, h: number, kind: AlbumItem["kind"]) => void;
  advance: (progress: number, note: string) => void;
};

type Prepared = { item: AlbumItem; stats: ImageStats | null };

async function prepare(
  convex: ConvexReactClient,
  file: File,
  hooks: Hooks,
): Promise<Prepared> {
  if (file.type.startsWith("video/")) {
    const shape = await measureVideo(file);
    hooks.measured(shape.w, shape.h, "video");

    const video = await prepareVideo(file, (fraction) => {
      hooks.advance(fraction * TRANSCODE_SHARE, "Compressing");
    });
    const [src, poster] = await Promise.all([
      put(convex, video.blob, video.type, (fraction) => {
        hooks.advance(TRANSCODE_SHARE + fraction * (1 - TRANSCODE_SHARE), "Uploading");
      }),
      video.poster ? put(convex, video.poster, "image/webp") : null,
    ]);
    return {
      item: {
        kind: "video",
        src,
        w: video.w,
        h: video.h,
        ...(poster ? { poster } : {}),
      },
      // A film's colour is its first frame's, which is the frame the tile shows
      // anyway — so what is measured is exactly what an album reads as.
      stats: video.poster ? await statsOf(video.poster) : null,
    };
  }

  const image = await prepareImage(file, hooks);
  const src = await put(convex, image.blob, image.type, (fraction) => {
    hooks.advance(fraction, "Uploading");
  });
  return {
    item: { kind: "image", src, w: image.w, h: image.h },
    stats: image.stats,
  };
}

/** Colour off a blob nothing has decoded yet — the video poster's path in. */
async function statsOf(blob: Blob): Promise<ImageStats | null> {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) return null;
  try {
    return statsFrom(bitmap);
  } finally {
    bitmap.close();
  }
}

async function prepareImage(
  file: File,
  hooks: Hooks,
): Promise<{ blob: Blob; type: string; w: number; h: number; stats: ImageStats | null }> {
  // `from-image` is load-bearing: a phone writes the rotation into EXIF rather
  // than into the pixels, and the default here ignores it — every portrait
  // photo would arrive on its side, and its w/h would describe the wrong shape.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    // The shape is known now, and the shape is all the waterfall needs.
    hooks.measured(w, h, "image");

    // An animated GIF has nothing to gain and a whole animation to lose.
    if (file.type === "image/gif") {
      return {
        blob: file,
        type: file.type,
        w: bitmap.width,
        h: bitmap.height,
        stats: statsFrom(bitmap),
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
    // Read here, off the canvas that exists anyway, before the encode. It is
    // the one moment in a picture's life when its pixels are in hand and
    // same-origin — after this it is a URL on another host, where a canvas
    // cannot read it back at all.
    const stats = statsFrom(canvas);

    const webp = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", IMAGE_QUALITY);
    });
    // A small, already-tight photo can encode LARGER than it arrived. Keeping
    // the smaller of the two is what stops "compression" adding weight.
    if (!webp || (scale === 1 && webp.size >= file.size)) {
      return { blob: file, type: file.type, w: bitmap.width, h: bitmap.height, stats };
    }
    return { blob: webp, type: "image/webp", w, h, stats };
  } finally {
    bitmap.close();
  }
}

/**
 * Bytes → the permanent URL the album will hold.
 *
 * `XMLHttpRequest` rather than `fetch`, for the one thing it still does better:
 * it reports how much of the body has gone. On a 60MB video that is the
 * difference between a progress bar and a spinner.
 *
 * Exported for the lightbox, whose crops and trims land through the same door.
 */
export function put(
  convex: ConvexReactClient,
  blob: Blob,
  type: string,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  return convex
    .mutation(api.albums.generateUploadUrl, {})
    .then(
      (uploadUrl) =>
        new Promise<Id<"_storage">>((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open("POST", uploadUrl);
          request.setRequestHeader("Content-Type", type);
          request.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress?.(event.loaded / event.total);
          };
          request.onload = () => {
            if (request.status < 200 || request.status >= 300) {
              reject(new Error("upload failed"));
              return;
            }
            try {
              resolve((JSON.parse(request.responseText) as { storageId: Id<"_storage"> }).storageId);
            } catch {
              reject(new Error("upload returned nonsense"));
            }
          };
          request.onerror = () => reject(new Error("upload failed"));
          request.send(blob);
        }),
    )
    .then(async (storageId) => {
      const url = await convex.query(api.albums.url, { storageId });
      if (!url) throw new Error("upload vanished");
      return url;
    });
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)}MB`;
}
