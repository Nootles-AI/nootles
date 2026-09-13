import type { ViewportController } from "./engine/useViewport";
import { absoluteSelectionBounds } from "./scene/geometry";
import { laidOutScene } from "./scene/autoLayout";
import { serializeScene } from "./scene/serialize";
import type { Scene } from "./scene/types";

export function downloadCanvas(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function canvasSourceFile(scene: Scene): Blob {
  return new Blob([serializeScene(scene)], { type: "text/plain;charset=utf-8" });
}

/** On-demand raster projection, independent of zoom; never mutates the live scene DOM. */
export async function canvasPng(scene: Scene, viewport: ViewportController, scale: number): Promise<Blob> {
  const live = viewport.sceneRef.current;
  if (!live || !live.isConnected) throw new Error("The canvas is no longer open.");
  const laid = laidOutScene(scene);
  const visible = laid.nodes.filter((node) => !node.hidden && node.style.display !== "none");
  const bounds = visible.length ? absoluteSelectionBounds(laid, visible.map((node) => node.id)) : { x: 0, y: 0, w: scene.w, h: scene.h };
  const width = Math.ceil(bounds.w + 64), height = Math.ceil(bounds.h + 64);
  if (![width, height, scale].every(Number.isFinite) || scale < 1 || scale > 3 || width * height * scale * scale > 16_000_000 || Math.max(width, height) * scale > 16_000) {
    throw new Error("This export exceeds 16 megapixels. Use a lower scale or export the NML source.");
  }
  const snapshot = document.createElement("div");
  const clone = live.cloneNode(true) as HTMLDivElement;
  const computed = getComputedStyle(viewport.containerRef.current!);
  for (const property of computed) {
    if (property.startsWith("--") || /^(font|color|line-height|letter-spacing|direction)/.test(property)) snapshot.style.setProperty(property, computed.getPropertyValue(property));
  }
  // Transform offscreen, not left: computed logical insets would otherwise
  // survive html-to-image's physical left override and move the exported root away.
  Object.assign(snapshot.style, { position: "fixed", left: "0", top: "0", transform: "translateX(-100000px)", width: `${width}px`, height: `${height}px`, overflow: "hidden", background: computed.backgroundColor });
  Object.assign(clone.style, { transform: `translate(${32 - bounds.x}px, ${32 - bounds.y}px)`, transformOrigin: "0 0", width: `${live.clientWidth}px`, height: `${live.clientHeight}px`, willChange: "auto" });
  clone.querySelectorAll(".nt-ov, .nt-edge-hit").forEach((node) => node.remove());
  clone.querySelectorAll(".is-selected, .is-hovered").forEach((node) => node.classList.remove("is-selected", "is-hovered"));
  clone.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
  snapshot.append(clone);
  document.body.append(snapshot);
  try {
    await document.fonts.ready;
    const images = [...snapshot.querySelectorAll("img")];
    await Promise.all(images.map(async (image) => { if (!image.complete) await image.decode(); if (!image.naturalWidth) throw new Error("An image has not loaded. Wait for it and try again."); }));
    const { toBlob } = await import("html-to-image");
    const blob = await toBlob(snapshot, { width, height, pixelRatio: scale, style: { position: "relative", transform: "none", insetInline: "0 auto", insetBlock: "0 auto" } });
    if (!blob) throw new Error("The browser could not create this image.");
    return blob;
  } finally { snapshot.remove(); }
}
