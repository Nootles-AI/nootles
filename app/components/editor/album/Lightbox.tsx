"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useConvex } from "convex/react";
import {
  ChevronLeft,
  ChevronRight,
  Crop,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  X,
} from "@/app/components/Icons";
import { editVideo } from "./video";
import { put } from "./upload";
import type { AlbumItem } from "./types";

/**
 * One picture, as big as the window will allow — and, when the album is
 * editable, the place it gets re-cut: crop for a photo, trim and crop for a
 * video. An edit is processed here (canvas for stills, the same ffmpeg the
 * upload used for clips), stored through the same door the upload used, and
 * handed back as a replacement item — the document never holds a picture that
 * is halfway anything.
 *
 * Over the whole page rather than inside the block, which is why it is a
 * portal: an album is 600px of a document column and the picture in it is not.
 *
 * It takes focus on open. Not for the ring — for the keys: the album lives
 * inside a contentEditable, and arrows that reached ProseMirror would page the
 * lightbox and move the caret at the same time.
 */

/** A region of the picture, in fractions of it — pixels come at the end. */
type Region = { x: number; y: number; w: number; h: number };

const WHOLE: Region = { x: 0, y: 0, w: 1, h: 1 };

/** No crop may be thinner than this, or the grips land on each other. */
const LEAST = 0.05;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** `74.3s` → `1:14.3` — tenths matter when placing a cut. */
function stamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
  onReplace,
}: {
  items: readonly AlbumItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Absent in a viewer, and the edit bar is absent with it. */
  onReplace?: (index: number, item: AlbumItem) => void;
}) {
  const item = items[index];
  // A deleted last picture, or an album emptied under it.
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);
  if (!item) return null;

  return createPortal(
    // Keyed to the picture: paging, and an edit landing as a new file, both
    // reset the editing state by replacement rather than by bookkeeping.
    <View
      key={item.src}
      item={item}
      count={items.length}
      index={index}
      onIndex={onIndex}
      onClose={onClose}
      onReplace={onReplace}
    />,
    document.body,
  );
}

function View({
  item,
  count,
  index,
  onIndex,
  onClose,
  onReplace,
}: {
  item: AlbumItem;
  count: number;
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onReplace?: (index: number, item: AlbumItem) => void;
}) {
  const convex = useConvex();
  const frame = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLImageElement | HTMLVideoElement | null>(null);

  const [mode, setMode] = useState<"crop" | "trim" | null>(null);
  const [region, setRegion] = useState<Region>(WHOLE);
  const [cut, setCut] = useState<{ start: number; end: number } | null>(null);
  const [length, setLength] = useState(0);
  /** What the wait is doing, or null. Cleared by the new picture arriving. */
  const [busy, setBusy] = useState<string | null>(null);
  const [oops, setOops] = useState<string | null>(null);

  useEffect(() => {
    frame.current?.focus();
  }, []);

  // A branch swap in the bar can unmount the very button that held focus,
  // dropping it to the body — and Escape with it. The dialog keeps its keys.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body)
      frame.current?.focus();
  }, [mode, busy, oops]);

  const step = (by: number) => onIndex((index + by + count) % count);

  const enterCrop = () => {
    if (media.current instanceof HTMLVideoElement) media.current.pause();
    setRegion(WHOLE);
    setOops(null);
    setMode("crop");
  };

  const enterTrim = () => {
    const el = media.current;
    if (!(el instanceof HTMLVideoElement)) return;
    const d = el.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    el.pause();
    setLength(d);
    setCut({ start: 0, end: d });
    setOops(null);
    setMode("trim");
  };

  const cropped =
    mode === "crop" &&
    (region.x > 0.005 || region.y > 0.005 || region.w < 0.995 || region.h < 0.995);
  const trimmed =
    mode === "trim" &&
    cut !== null &&
    length > 0 &&
    (cut.start > 0.05 || cut.end < length - 0.05);

  const apply = async () => {
    if (!onReplace) return;
    setOops(null);
    try {
      if (item.kind === "image") {
        setBusy("Cropping…");
        const source = await (await fetch(item.src)).blob();
        const bitmap = await createImageBitmap(source);
        const sx = Math.round(region.x * bitmap.width);
        const sy = Math.round(region.y * bitmap.height);
        const sw = Math.max(1, Math.round(region.w * bitmap.width));
        const sh = Math.max(1, Math.round(region.h * bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext("2d")?.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
        bitmap.close();
        const webp = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, "image/webp", 0.82);
        });
        if (!webp) throw new Error("encode failed");
        setBusy("Saving…");
        const src = await put(convex, webp, "image/webp");
        onReplace(index, { kind: "image", src, w: sw, h: sh });
      } else {
        const el = media.current;
        const vw = (el instanceof HTMLVideoElement && el.videoWidth) || item.w;
        const vh = (el instanceof HTMLVideoElement && el.videoHeight) || item.h;
        // x264 will not take odd sizes; nothing is lost rounding down to even.
        const even = (n: number) => 2 * Math.floor(n / 2);
        setBusy("Cutting…");
        const source = await (await fetch(item.src)).blob();
        const done = await editVideo(
          source,
          {
            ...(trimmed && cut
              ? { start: Math.max(0, cut.start), end: Math.min(length, cut.end) }
              : {}),
            ...(cropped
              ? {
                  crop: {
                    x: even(region.x * vw),
                    y: even(region.y * vh),
                    w: Math.max(2, even(region.w * vw)),
                    h: Math.max(2, even(region.h * vh)),
                  },
                }
              : {}),
          },
          (fraction) => setBusy(`Cutting… ${Math.round(fraction * 100)}%`),
        );
        setBusy("Saving…");
        const [src, poster] = await Promise.all([
          put(convex, done.blob, done.type),
          done.poster ? put(convex, done.poster, "image/webp") : null,
        ]);
        onReplace(index, {
          kind: "video",
          src,
          w: done.w,
          h: done.h,
          ...(poster ? { poster } : {}),
        });
      }
      // Busy stays up until the replacement arrives and remounts this view.
    } catch {
      setBusy(null);
      setOops("That didn't save — try again.");
    }
  };

  return (
    <div
      ref={frame}
      // Editing is a scene change: the room deepens to near-black around the
      // work, the way the Photos editor drops its chrome to black.
      className={`nt-album-lightbox${mode || busy ? " is-editing" : ""}`}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Album"
      onPointerDown={(event) => {
        // The backdrop only: a press that started on the picture is a press on
        // the picture, wherever it happens to end. Mid-edit it does nothing at
        // all — a press that just missed a grip must not throw the crop away.
        if (event.target !== event.currentTarget || busy || mode) return;
        onClose();
      }}
      onKeyDown={(event) => {
        if (busy) return;
        if (event.key === "Escape") {
          if (mode) setMode(null);
          else onClose();
        } else if (mode && event.key === "Enter" && (cropped || trimmed))
          void apply();
        else if (!mode && event.key === "ArrowRight") step(1);
        else if (!mode && event.key === "ArrowLeft") step(-1);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div ref={box} className="nt-album-editbox">
        {item.kind === "video" ? (
          <video
            ref={(el) => {
              media.current = el;
            }}
            className="nt-album-full"
            src={item.src}
            poster={item.poster}
            controls={!mode && !busy}
            loop
            playsInline
            autoPlay
            onLoadedMetadata={(event) =>
              setLength(event.currentTarget.duration || 0)
            }
          />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- a storage URL
             next/image has no loader for, shown at whatever size the window is */
          <img
            ref={(el) => {
              media.current = el;
            }}
            className="nt-album-full"
            src={item.src}
            alt=""
          />
        )}
        {mode === "crop" && !busy && (
          <CropFrame region={region} onRegion={setRegion} box={box} />
        )}
      </div>

      {count > 1 && !mode && !busy && (
        <>
          <button
            type="button"
            className="nt-album-page is-prev"
            aria-label="Previous"
            onClick={() => step(-1)}
          >
            <ChevronLeft />
          </button>
          <button
            type="button"
            className="nt-album-page is-next"
            aria-label="Next"
            onClick={() => step(1)}
          >
            <ChevronRight />
          </button>
          <p className="nt-album-count">
            {index + 1} / {count}
          </p>
        </>
      )}

      {onReplace && (
        <div className="nt-album-dock">
          {oops && !busy && <p className="nt-album-dock-note">{oops}</p>}
          {busy ? (
            <div className="nt-album-busy">
              <span className="nt-album-busy-spin" aria-hidden />
              {busy}
            </div>
          ) : mode === null ? (
            <div className="nt-album-modes">
              <button type="button" className="nt-album-mode" onClick={enterCrop}>
                <span className="nt-album-mode-chip">
                  <Crop />
                </span>
                Crop
              </button>
              {item.kind === "video" && (
                <button
                  type="button"
                  className="nt-album-mode"
                  onClick={enterTrim}
                >
                  <span className="nt-album-mode-chip">
                    <Scissors />
                  </span>
                  Trim
                </button>
              )}
              {item.of && (
                <button
                  type="button"
                  className="nt-album-mode"
                  title="Back to the picture as it was added"
                  onClick={() => {
                    const of = item.of;
                    if (!of) return;
                    onReplace(index, {
                      kind: item.kind,
                      src: of.src,
                      w: of.w,
                      h: of.h,
                      ...(of.poster ? { poster: of.poster } : {}),
                    });
                  }}
                >
                  <span className="nt-album-mode-chip">
                    <RotateCcw />
                  </span>
                  Reset
                </button>
              )}
            </div>
          ) : (
            <>
              {mode === "trim" && cut && (
                <TrimStrip
                  media={media}
                  src={item.src}
                  cut={cut}
                  length={length}
                  onCut={setCut}
                />
              )}
              <div className="nt-album-actions">
                <button
                  type="button"
                  className="nt-album-action"
                  onClick={() => setMode(null)}
                >
                  Cancel
                </button>
                <span className="nt-album-actions-what">{mode}</span>
                <button
                  type="button"
                  className="nt-album-action is-done"
                  disabled={!cropped && !trimmed}
                  onClick={() => void apply()}
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {!busy && !mode && (
        <button
          type="button"
          className="nt-album-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X />
        </button>
      )}
    </div>
  );
}

/**
 * The crop, drawn as the Photos editor draws one: a bright window ruled into
 * thirds, corner brackets and edge bars to take hold of, the rest of the
 * picture sunk into the room's near-black. Corners and edges resize it, the
 * middle carries it; everything is fractions of the picture, so the same
 * numbers cut the full-resolution file at the end.
 */
const GRIPS: { key: string; fx: -1 | 0 | 1; fy: -1 | 0 | 1 }[] = [
  { key: "nw", fx: -1, fy: -1 },
  { key: "n", fx: 0, fy: -1 },
  { key: "ne", fx: 1, fy: -1 },
  { key: "e", fx: 1, fy: 0 },
  { key: "se", fx: 1, fy: 1 },
  { key: "s", fx: 0, fy: 1 },
  { key: "sw", fx: -1, fy: 1 },
  { key: "w", fx: -1, fy: 0 },
];

function CropFrame({
  region,
  onRegion,
  box,
}: {
  region: Region;
  onRegion: (region: Region) => void;
  box: RefObject<HTMLDivElement | null>;
}) {
  const grip = useRef<{
    px: number;
    py: number;
    was: Region;
    fx: number;
    fy: number;
    carry: boolean;
    w: number;
    h: number;
  } | null>(null);

  const hold = (
    event: ReactPointerEvent,
    fx: number,
    fy: number,
    carry = false,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    grip.current = {
      px: event.clientX,
      py: event.clientY,
      was: region,
      fx,
      fy,
      carry,
      w: rect.width,
      h: rect.height,
    };
  };

  const drag = (event: ReactPointerEvent) => {
    const g = grip.current;
    if (!g) return;
    const dx = (event.clientX - g.px) / g.w;
    const dy = (event.clientY - g.py) / g.h;
    const { was } = g;
    if (g.carry) {
      onRegion({
        ...was,
        x: clamp(was.x + dx, 0, 1 - was.w),
        y: clamp(was.y + dy, 0, 1 - was.h),
      });
      return;
    }
    let x1 = was.x;
    let y1 = was.y;
    let x2 = was.x + was.w;
    let y2 = was.y + was.h;
    if (g.fx < 0) x1 = clamp(x1 + dx, 0, x2 - LEAST);
    if (g.fx > 0) x2 = clamp(x2 + dx, x1 + LEAST, 1);
    if (g.fy < 0) y1 = clamp(y1 + dy, 0, y2 - LEAST);
    if (g.fy > 0) y2 = clamp(y2 + dy, y1 + LEAST, 1);
    onRegion({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  };

  const done = () => {
    grip.current = null;
  };

  return (
    <div
      className="nt-album-crop"
      style={{
        left: `${region.x * 100}%`,
        top: `${region.y * 100}%`,
        width: `${region.w * 100}%`,
        height: `${region.h * 100}%`,
      }}
      onPointerDown={(event) => hold(event, 0, 0, true)}
      onPointerMove={drag}
      onPointerUp={done}
      onPointerCancel={done}
    >
      {GRIPS.map(({ key, fx, fy }) => (
        <span
          key={key}
          className={`nt-album-crop-grip is-${key}`}
          onPointerDown={(event) => hold(event, fx, fy)}
        />
      ))}
    </div>
  );
}

/**
 * The clip laid out as its own frames — the Photos trimmer's filmstrip —
 * bracketed by two grips; between them, what is kept. Dragging a grip shows
 * the frame it would cut at, which is the only honest way to place a cut, and
 * the play button runs just the kept stretch, which is the only honest
 * preview of one.
 */
function TrimStrip({
  media,
  src,
  cut,
  length,
  onCut,
}: {
  media: RefObject<HTMLImageElement | HTMLVideoElement | null>;
  src: string;
  cut: { start: number; end: number };
  length: number;
  onCut: (cut: { start: number; end: number }) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const side = useRef<"start" | "end" | "scrub" | null>(null);
  const [film, setFilm] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const clip = () =>
    media.current instanceof HTMLVideoElement ? media.current : null;

  // The strip's frames, read once from the same file the clip is playing.
  useEffect(() => {
    let gone = false;
    void filmstrip(src, length)
      .then((url) => {
        if (!gone) setFilm(url);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [src, length]);

  // The playhead rides the clip's own clock — written straight to the
  // element, because a React render per frame would be sixty a second.
  useEffect(() => {
    let raf = requestAnimationFrame(function tick() {
      const el = clip();
      if (el && head.current && length > 0)
        head.current.style.left = `${(el.currentTime / length) * 100}%`;
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clip() reads a ref
  }, [length]);

  // Playing previews the cut: it runs out at the end grip, not the file's end.
  useEffect(() => {
    const el = clip();
    if (!el) return;
    const over = () => {
      if (el.currentTime >= cut.end - 0.02 && !el.paused) el.pause();
    };
    const began = () => setPlaying(true);
    const ended = () => setPlaying(false);
    el.addEventListener("timeupdate", over);
    el.addEventListener("play", began);
    el.addEventListener("pause", ended);
    return () => {
      el.removeEventListener("timeupdate", over);
      el.removeEventListener("play", began);
      el.removeEventListener("pause", ended);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clip() reads a ref
  }, [cut.end]);

  const toggle = () => {
    const el = clip();
    if (!el) return;
    if (el.paused) {
      if (el.currentTime < cut.start || el.currentTime >= cut.end - 0.05)
        el.currentTime = cut.start;
      void el.play().catch(() => {});
    } else el.pause();
  };

  const timeAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return clamp(((clientX - rect.left) / rect.width) * length, 0, length);
  };

  const seek = (to: number) => {
    const el = clip();
    if (!el) return;
    el.pause();
    el.currentTime = to;
  };

  const hold = (event: ReactPointerEvent, which: "start" | "end") => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    side.current = which;
  };

  /** Anywhere on the strip that is not a grip scrubs the clip. */
  const scrub = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    side.current = "scrub";
    seek(timeAt(event.clientX));
  };

  const drag = (event: ReactPointerEvent) => {
    if (!side.current) return;
    const t = timeAt(event.clientX);
    if (side.current === "scrub") {
      seek(t);
      return;
    }
    // A cut must keep something: the grips stop a fifth of a second apart.
    const next =
      side.current === "start"
        ? { start: Math.min(t, cut.end - 0.2), end: cut.end }
        : { start: cut.start, end: Math.max(t, cut.start + 0.2) };
    onCut(next);
    seek(side.current === "start" ? next.start : next.end);
  };

  const done = () => {
    side.current = null;
  };

  const set = cut.start > 0.05 || cut.end < length - 0.05;
  const from = (cut.start / length) * 100;
  const upto = (cut.end / length) * 100;

  return (
    <div className={`nt-album-trim${set ? " is-set" : ""}`}>
      <button
        type="button"
        className="nt-album-trim-play"
        aria-label={playing ? "Pause" : "Play the kept stretch"}
        onClick={toggle}
      >
        {playing ? <Pause /> : <Play />}
      </button>
      <span className="nt-album-trim-time">{stamp(cut.start)}</span>
      <div
        ref={track}
        className="nt-album-trim-track"
        onPointerDown={scrub}
        onPointerMove={drag}
        onPointerUp={done}
        onPointerCancel={done}
      >
        {film && (
          /* eslint-disable-next-line @next/next/no-img-element -- a canvas of
             the clip's own frames, drawn moments ago */
          <img className="nt-album-trim-film" src={film} alt="" draggable={false} />
        )}
        <div
          className="nt-album-trim-shade is-before"
          style={{ width: `${from}%` }}
        />
        <div
          className="nt-album-trim-shade is-after"
          style={{ width: `${100 - upto}%` }}
        />
        <div ref={head} className="nt-album-trim-head" />
        <div
          className="nt-album-trim-keep"
          style={{ left: `${from}%`, right: `${100 - upto}%` }}
        />
        <span
          className="nt-album-trim-grip is-start"
          style={{ left: `${from}%` }}
          onPointerDown={(event) => hold(event, "start")}
        >
          <ChevronLeft />
        </span>
        <span
          className="nt-album-trim-grip is-end"
          style={{ left: `${upto}%` }}
          onPointerDown={(event) => hold(event, "end")}
        >
          <ChevronRight />
        </span>
      </div>
      <span className="nt-album-trim-time">{stamp(cut.end)}</span>
    </div>
  );
}

/**
 * The strip's frames: the clip decoded once more, seeked across its length,
 * each stop drawn into one long canvas. Read through a blob URL so the canvas
 * stays clean wherever the file is actually stored, and returned as one image
 * because that is all the strip needs — the last thing a trim bar should cost
 * is a decode per thumbnail.
 */
async function filmstrip(src: string, length: number): Promise<string> {
  const blob = await (await fetch(src)).blob();
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    await new Promise<void>((ok, no) => {
      const bail = setTimeout(() => no(new Error("undecodable")), 10_000);
      video.addEventListener(
        "loadeddata",
        () => {
          clearTimeout(bail);
          ok();
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        () => {
          clearTimeout(bail);
          no(new Error("undecodable"));
        },
        { once: true },
      );
    });
    // Drawn at twice the strip's CSS size, so the frames stay sharp on the
    // displays that will actually show them.
    const height = 112;
    const ratio = (video.videoWidth || 16) / (video.videoHeight || 9);
    const thumb = Math.max(48, Math.round(height * ratio));
    const across = Math.ceil(1120 / thumb);
    const canvas = document.createElement("canvas");
    canvas.width = thumb * across;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("no context");
    for (let i = 0; i < across; i++) {
      await new Promise<void>((ok) => {
        const bail = setTimeout(ok, 2_000);
        video.addEventListener(
          "seeked",
          () => {
            clearTimeout(bail);
            ok();
          },
          { once: true },
        );
        video.currentTime = clamp(
          ((i + 0.5) / across) * length,
          0,
          Math.max(0, length - 0.05),
        );
      });
      g.drawImage(video, i * thumb, 0, thumb, height);
    }
    return canvas.toDataURL("image/jpeg", 0.7);
  } finally {
    URL.revokeObjectURL(url);
  }
}
