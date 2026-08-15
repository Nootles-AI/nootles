"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MAX_VIDEO_BYTES, prepareVideo } from "./video";
import type { AlbumItem } from "./types";

/**
 * Files on their way into an album.
 *
 * Everything is made smaller before it is uploaded, never after: a photo is
 * redrawn at screen size and re-encoded as WebP, a video goes through ffmpeg
 * (see `video.ts`). What reaches storage is what the page will load, so there is
 * no second, heavier copy of an album sitting behind the one being served.
 *
 * A batch lands IN THE ORDER IT WAS CHOSEN even though the files finish out of
 * order — a small photo behind a long video would otherwise overtake it, and an
 * album that shuffles the pictures as it fills is unsettling to watch. Each
 * result waits for the ones before it, which costs nothing and looks deliberate.
 */

/** Long edge, in pixels: retina-sharp at any width the block can be dragged to. */
const MAX_IMAGE_EDGE = 2560;

/** WebP quality. Visually clean; roughly a sixth of a phone photo's JPEG. */
const IMAGE_QUALITY = 0.82;

/** How many files are worked on at once. Encoding is CPU-bound, not network-bound. */
const LANES = 3;

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

export type Progress = {
  /** Files in this batch, and how many have landed. */
  total: number;
  done: number;
  /** What is happening to the file being worked on, for the counter's second line. */
  note: string;
};

export type Handlers = {
  /** One landed item, ready to append to the album. */
  onItem: (item: AlbumItem) => void;
  onProgress: (progress: Progress | null) => void;
  /** A file that could not be taken, said in words the uploader can act on. */
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
 * Compresses and uploads a batch, reporting each item as it lands.
 *
 * Resolves when the batch is finished, whatever happened to it: a file that
 * fails is reported through `onError` and skipped, because one unreadable photo
 * must not cost the other nineteen.
 */
export async function ingest(
  convex: ConvexReactClient,
  files: File[],
  handlers: Handlers,
): Promise<void> {
  const { taken, refused } = acceptable(files);
  for (const message of refused) handlers.onError(message);
  if (!taken.length) return;

  const results = new Array<AlbumItem | null | undefined>(taken.length);
  let flushed = 0;
  let done = 0;
  let note = "";

  const report = () => {
    handlers.onProgress({ total: taken.length, done, note });
  };

  /** Hand over everything now complete from the front of the queue. */
  const flush = () => {
    while (flushed < results.length && results[flushed] !== undefined) {
      const item = results[flushed++];
      if (item) handlers.onItem(item);
    }
  };

  report();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, taken.length) }, async () => {
      while (next < taken.length) {
        const index = next++;
        const file = taken[index];
        try {
          results[index] = await prepare(convex, file, (progress) => {
            note = progress;
            report();
          });
        } catch {
          results[index] = null;
          handlers.onError(`${file.name || "A file"} didn't upload. Try adding it again.`);
        }
        done++;
        note = "";
        flush();
        report();
      }
    }),
  );

  handlers.onProgress(null);
}

async function prepare(
  convex: ConvexReactClient,
  file: File,
  onNote: (note: string) => void,
): Promise<AlbumItem> {
  if (file.type.startsWith("video/")) {
    onNote(`Compressing ${file.name}`);
    const video = await prepareVideo(file, (fraction) => {
      onNote(`Compressing ${file.name} — ${Math.round(fraction * 100)}%`);
    });
    onNote(`Uploading ${file.name}`);
    const [src, poster] = await Promise.all([
      put(convex, video.blob, video.type),
      video.poster ? put(convex, video.poster, "image/webp") : null,
    ]);
    return {
      kind: "video",
      src,
      w: video.w,
      h: video.h,
      ...(poster ? { poster } : {}),
    };
  }

  const image = await prepareImage(file);
  onNote(`Uploading ${file.name}`);
  return { kind: "image", src: await put(convex, image.blob, image.type), w: image.w, h: image.h };
}

async function prepareImage(
  file: File,
): Promise<{ blob: Blob; type: string; w: number; h: number }> {
  // `from-image` is load-bearing: a phone writes the rotation into EXIF rather
  // than into the pixels, and the default here ignores it — every portrait
  // photo would arrive on its side, and its w/h would describe the wrong shape.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    // An animated GIF has nothing to gain and a whole animation to lose.
    if (file.type === "image/gif") {
      return { blob: file, type: file.type, w: bitmap.width, h: bitmap.height };
    }

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);

    const webp = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", IMAGE_QUALITY);
    });
    // A small, already-tight photo can encode LARGER than it arrived. Keeping
    // the smaller of the two is what stops "compression" adding weight.
    if (!webp || (scale === 1 && webp.size >= file.size)) {
      return { blob: file, type: file.type, w: bitmap.width, h: bitmap.height };
    }
    return { blob: webp, type: "image/webp", w, h };
  } finally {
    bitmap.close();
  }
}

/** Bytes → the permanent URL the album will hold. */
async function put(
  convex: ConvexReactClient,
  blob: Blob,
  type: string,
): Promise<string> {
  const uploadUrl = await convex.mutation(api.albums.generateUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": type },
    body: blob,
  });
  if (!response.ok) throw new Error("upload failed");

  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  const url = await convex.query(api.albums.url, { storageId });
  if (!url) throw new Error("upload vanished");
  return url;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)}MB`;
}
