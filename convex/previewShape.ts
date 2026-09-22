/**
 * What a stored page preview holds — pure, no imports, so the browser writers
 * and the server's gate share one definition (the `yshape.ts` bargain).
 */

/** Past this nothing is above a thumbnail's crop, even on the tallest card. */
export const PREVIEW_BLOCKS = 18;

/**
 * The heaviest preview worth keeping. A preview is a convenience read, and a
 * page whose first blocks outweigh this (a drawn storyboard is ~100KB a shot)
 * is cheaper to leave to the live read than to carry on every card.
 */
export const PREVIEW_MAX_CHARS = 256_000;

/** The preview of a document, or null when its top is too heavy to keep. */
export function encodePreview(blocks: readonly unknown[]): string | null {
  const encoded = JSON.stringify(blocks.slice(0, PREVIEW_BLOCKS));
  return encoded.length <= PREVIEW_MAX_CHARS ? encoded : null;
}
