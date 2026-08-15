"use client";

import type { FFmpeg } from "@ffmpeg/ffmpeg";

/**
 * Getting a video down to something a document can hold.
 *
 * Compression happens in the browser, through ffmpeg compiled to WebAssembly —
 * about 30MB of it, so it is imported on the first video anyone drops and never
 * on a page that has none. A clip becomes H.264 in an MP4 with its metadata at
 * the front, capped at 1280 on the long edge: the format every browser plays
 * without asking, at a size a page can autoplay several of.
 *
 * Two rules keep the wait honest. A small MP4 is passed through untouched —
 * transcoding it would cost a minute to save nothing — and any failure at all,
 * ffmpeg refusing to load included, falls back to uploading the file as it came.
 * A slow video is a disappointment; a lost one is a bug.
 */

/** Bigger than this and the browser is the wrong place to be doing this at all. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** An MP4 under this is already small enough that transcoding only costs time. */
const PASS_THROUGH_BYTES = 8 * 1024 * 1024;

/** Long edge, in pixels. A tile is 200px wide; this is generous already. */
const MAX_EDGE = 1280;

/** How long to wait for a frame to decode before giving up on the poster. */
const DECODE_TIMEOUT = 10_000;

export type PreparedVideo = {
  blob: Blob;
  type: string;
  w: number;
  h: number;
  /** Null when the browser could not decode a frame to draw. */
  poster: Blob | null;
};

let engine: Promise<FFmpeg> | null = null;

/**
 * The one ffmpeg instance, loaded once. Held at module scope rather than in the
 * block: it costs 30MB to build, a page can hold several albums, and it is
 * driven one file at a time from `upload.ts` regardless.
 */
function loadEngine(): Promise<FFmpeg> {
  engine ??= (async () => {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ffmpeg = new FFmpeg();
    await ffmpeg.load();
    return ffmpeg;
  })().catch((error: unknown) => {
    // Not cached: a load that failed on a flaky network should be retried by
    // the next video rather than condemning every video in the session.
    engine = null;
    throw error;
  });
  return engine;
}

/**
 * ffmpeg is one machine with one filesystem: a second `exec` while the first is
 * running writes over its files. Videos queue here rather than at the call site,
 * so nothing upstream has to remember that.
 */
let lane: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lane.then(work, work);
  lane = next.catch(() => {});
  return next;
}

/** `video/quicktime` → `mov`. ffmpeg reads the container from the name. */
function extensionOf(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,4}$/.test(fromName)) return fromName;
  return file.type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "mp4";
}

/**
 * A video's shape, read before any of the work.
 *
 * Metadata only — no seek, no frame drawn — because this runs to put an outline
 * in the waterfall while the file is still being compressed, and it must cost
 * nothing. A video the browser cannot decode answers with the shape a phone
 * films in, which is a better guess than a square.
 */
export function measureVideo(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;

    const done = (w: number, h: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve({ w, h });
    };
    const timer = setTimeout(() => done(16, 9), DECODE_TIMEOUT);

    video.preload = "metadata";
    video.muted = true;
    video.addEventListener("error", () => done(16, 9));
    video.addEventListener("loadedmetadata", () => {
      done(video.videoWidth || 16, video.videoHeight || 9);
    });
    video.src = url;
  });
}

/**
 * The first frame, and the true size of what will be stored.
 *
 * Read off the *output* rather than the input, so the numbers describe the file
 * the tile will actually load. A video the browser cannot decode — an exotic
 * codec that survived the pass-through rule — answers with no poster, and the
 * caller falls back to the shape a phone films in.
 */
function probe(blob: Blob): Promise<Omit<PreparedVideo, "blob" | "type">> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    let settled = false;

    const done = (result: Omit<PreparedVideo, "blob" | "type">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const giveUp = () => done({ w: 16, h: 9, poster: null });
    const timer = setTimeout(giveUp, DECODE_TIMEOUT);

    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("error", giveUp);
    video.addEventListener("loadeddata", () => {
      // Not frame zero: the first frame of a phone video is often the lens
      // still opening, and a black poster reads as a broken tile.
      video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
    });
    video.addEventListener("seeked", () => {
      const w = video.videoWidth || 16;
      const h = video.videoHeight || 9;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
      canvas.toBlob((poster) => done({ w, h, poster }), "image/webp", 0.75);
    });
    video.src = url;
  });
}

/**
 * Compresses a video, or explains by returning it unchanged.
 *
 * `onProgress` reports 0–1 while ffmpeg runs, and is not called at all for a
 * file that passes straight through — there is nothing to wait for.
 */
export async function prepareVideo(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<PreparedVideo> {
  let blob: Blob = file;
  let type = file.type || "video/mp4";

  if (file.size > PASS_THROUGH_BYTES || file.type !== "video/mp4") {
    try {
      blob = await transcode(file, onProgress);
      type = "video/mp4";
    } catch {
      // Left as it came. The album would rather hold a heavy video than lose it.
      blob = file;
      type = file.type || "video/mp4";
    }
  }

  return { blob, type, ...(await probe(blob)) };
}

function transcode(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  return exclusive(() => runFfmpeg(file, onProgress));
}

async function runFfmpeg(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const ffmpeg = await loadEngine();
  const input = `in.${extensionOf(file)}`;
  const output = "out.mp4";

  const report = ({ progress }: { progress: number }) => {
    onProgress(Math.min(1, Math.max(0, progress)));
  };
  ffmpeg.on("progress", report);

  try {
    await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));
    await ffmpeg.exec([
      "-i", input,
      // A bounding box rather than a fixed size, so the long edge is capped
      // whichever way up the video was filmed and the aspect ratio survives.
      // x264 needs even dimensions; `force_divisible_by` is what guarantees it.
      "-vf", `scale='min(${MAX_EDGE},iw)':'min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "28",
      // Baseline chroma. Without it a video filmed in 4:2:2 encodes to something
      // Safari refuses to play, which is a silent failure on the tile.
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      // Metadata at the front, so playback can start before the file is whole.
      "-movflags", "+faststart",
      output,
    ]);
    const data = await ffmpeg.readFile(output);
    if (typeof data === "string") throw new Error("ffmpeg returned text");
    // Re-wrapped rather than passed straight in: ffmpeg types its output as a
    // view over any buffer, shared included, and a Blob will not take one.
    return new Blob([new Uint8Array(data)], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", report);
    // Best-effort: a file that was never written is not a failure to clean up.
    await ffmpeg.deleteFile(input).catch(() => {});
    await ffmpeg.deleteFile(output).catch(() => {});
  }
}
