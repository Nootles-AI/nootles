"use client";

import { AI } from "../aiConfig";

/** One picture as inline data, no larger than a model will look at it. */
export async function pictureFor(src: string): Promise<{ dataUri: string; mediaType: string } | null> {
  const blob = await fetch(src)
    .then((r) => (r.ok ? r.blob() : null))
    .catch(() => null);
  if (!blob) return null;
  // A picture the browser cannot redraw is still worth sending as it is.
  const sent = (await fitted(blob).catch(() => null)) ?? blob;
  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("unreadable"));
    reader.readAsDataURL(sent);
  }).catch(() => "");
  return dataUri ? { dataUri, mediaType: sent.type || "image/webp" } : null;
}

/** Redrawn at `AI.album.lookAtEdge` when it is larger; itself when it is not. */
async function fitted(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = AI.album.lookAtEdge / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const smaller = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );
    return smaller ?? blob;
  } finally {
    bitmap.close();
  }
}
