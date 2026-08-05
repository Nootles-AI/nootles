/**
 * A screenshot of what the reporter actually sees.
 *
 * html-to-image works on a clone of the DOM, and cloned nodes lose their
 * scroll positions — in an app that scrolls inside panels rather than the
 * window, that rendered every capture as "the page, scrolled to the top".
 * So the clone is made here instead, with each scrolled container's offset
 * baked in: children shifted by a transform (paint-only, so layout holds)
 * and the box clipped. The corrected clone is laid out off-screen at the
 * viewport's size and handed to the rasterizer.
 */
export async function captureViewport(): Promise<Blob | null> {
  const { toBlob } = await import("html-to-image");
  const source = document.body;

  const clone = source.cloneNode(true) as HTMLElement;
  const src = [source, ...Array.from(source.querySelectorAll<HTMLElement>("*"))];
  const dst = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
  for (let i = 0; i < src.length && i < dst.length; i++) {
    const s = src[i];
    if (!s.scrollTop && !s.scrollLeft) continue;
    const d = dst[i];
    d.style.overflow = "hidden";
    for (const child of Array.from(d.children) as HTMLElement[]) {
      child.style.transform = `translate(${-s.scrollLeft}px, ${-s.scrollTop}px)`;
    }
  }

  // Off-screen but attached and laid out — computed styles come back empty
  // on detached trees. The holder carries the viewport's size so that fixed
  // descendants (bars, the canvas chrome) land where the user sees them.
  const rect = source.getBoundingClientRect();
  const holder = document.createElement("div");
  holder.style.cssText =
    "position:fixed;top:0;left:0;pointer-events:none;transform:translateX(-200vw);" +
    `width:${rect.width}px;height:${rect.height}px;overflow:hidden;`;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    return await toBlob(clone, {
      pixelRatio: 1,
      filter: (node) =>
        !(node instanceof HTMLElement && node.dataset.ntFeedback !== undefined),
    });
  } finally {
    holder.remove();
  }
}
