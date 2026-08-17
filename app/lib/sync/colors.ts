/**
 * Presence colors: quiet enough for light mode, distinct enough to tell six
 * cursors apart, and stable per person — the same subject always hashes to
 * the same hue, so "the green one is Sam" survives a reload.
 *
 * Deliberately not the accent: amber means AI activity, and these mean
 * people. Muted mid-lightness tones, no saturated primaries.
 */
const PALETTE = [
  "#7a8a5c", // moss
  "#7d6f9e", // heather
  "#5f8a8b", // teal slate
  "#a2708a", // rosewood
  "#8a7a5c", // tobacco
  "#5c7a9e", // dusk blue
  "#9e6f5c", // clay
  "#6f8a6f", // sage
];

export function collabColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
