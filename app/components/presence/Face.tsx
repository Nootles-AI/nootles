"use client";

import { useState, type CSSProperties } from "react";

/** The heartbeat's own fallback, for rows that arrive with a blank name. */
export const displayName = (name: string) => name.trim() || "Someone";

const graphemes = new Intl.Segmenter();

/** First grapheme, not first code point — a flag or 🦊 survives intact. */
function monogram(name: string): string {
  for (const g of graphemes.segment(name)) return g.segment.toUpperCase();
  return "?";
}

/**
 * The face renders at 24px, but Clerk proxies the original OAuth photo —
 * hundreds of kilobytes for a spot this size. Its image API resizes on a
 * `width` param (ignored, harmlessly, on generated default avatars); foreign
 * URLs pass through untouched. 96 covers 3× displays with headroom.
 */
function avatarSrc(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "img.clerk.com") u.searchParams.set("width", "96");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * One person in a pile, as their photo or else their initial. Also the
 * members pile on a workspace's home, which has no presence colour to ring
 * a face in and so keeps the plain hairline.
 */
export function Face({
  user,
}: {
  user: { name: string; color?: string; imageUrl?: string | null };
}) {
  // Remembering which URL failed (not a boolean) lets a repaired avatar
  // recover without a remount.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const photo = user.imageUrl && user.imageUrl !== brokenUrl ? user.imageUrl : null;
  const name = displayName(user.name);
  return (
    <span
      className="nt-face"
      role="img"
      aria-label={name}
      title={name}
      style={{ "--face-color": user.color } as CSSProperties}
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarSrc(photo)}
          alt=""
          width={24}
          height={24}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setBrokenUrl(photo)}
        />
      ) : (
        <span aria-hidden>{monogram(name)}</span>
      )}
    </span>
  );
}
