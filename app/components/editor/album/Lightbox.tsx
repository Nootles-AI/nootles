"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "@/app/components/Icons";
import type { AlbumItem } from "./types";

/**
 * One picture, as big as the window will allow.
 *
 * Over the whole page rather than inside the block, which is why it is a portal:
 * an album is 600px of a document column and the picture in it is not.
 *
 * It takes focus on open. Not for the ring — for the keys: the album lives
 * inside a contentEditable, and arrows that reached ProseMirror would page the
 * lightbox and move the caret at the same time.
 */
export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: readonly AlbumItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    frame.current?.focus();
  }, []);

  const item = items[index];
  // A deleted last picture, or an album emptied under it.
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);
  if (!item) return null;

  const step = (by: number) => onIndex((index + by + items.length) % items.length);

  return createPortal(
    <div
      ref={frame}
      className="nt-album-lightbox"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Album"
      onPointerDown={(event) => {
        // The backdrop only: a press that started on the picture is a press on
        // the picture, wherever it happens to end.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        else if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {item.kind === "video" ? (
        <video
          key={item.src}
          className="nt-album-full"
          src={item.src}
          poster={item.poster}
          controls
          loop
          playsInline
          autoPlay
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element -- a storage URL
           next/image has no loader for, shown at whatever size the window is */
        <img key={item.src} className="nt-album-full" src={item.src} alt="" />
      )}

      {items.length > 1 && (
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
            {index + 1} / {items.length}
          </p>
        </>
      )}

      <button
        type="button"
        className="nt-album-close"
        aria-label="Close"
        onClick={onClose}
      >
        <X />
      </button>
    </div>,
    document.body,
  );
}
