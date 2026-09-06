/**
 * What a stub says about the block it stands for.
 *
 * Pure and dependency-free so every reader of a stub — the block, the page
 * thumbnail, the AI projection — names the thing the same way. A type this map
 * does not know is shown as Notion spells it: an honest name is better than a
 * vague one, and the raw type is exactly what a reader would search for.
 */

export type StubDescription = {
  label: string;
  reason: string;
  /** False when `label` is Notion's own type string rather than a product name. */
  known: boolean;
};

const NOT_BROUGHT = "Not brought across";

const KNOWN: Record<string, { label: string; reason?: string }> = {
  child_database: { label: "Notion database", reason: "Databases are not brought across" },
  synced_block: { label: "Synced block", reason: "Only the original holds the content" },
  template: { label: "Template" },
  bookmark: { label: "Bookmark", reason: "Its link could not be used" },
  embed: { label: "Embed", reason: "Its link could not be used" },
  link_preview: { label: "Link preview", reason: "Its link could not be used" },
  image: { label: "Image", reason: "Its file could not be reached" },
  video: { label: "Video", reason: "Its file could not be reached" },
  audio: { label: "Audio", reason: "Its file could not be reached" },
  file: { label: "File", reason: "Its file could not be reached" },
  pdf: { label: "PDF", reason: "Its file could not be reached" },
};

export function describeStub(notionType: string): StubDescription {
  const known = KNOWN[notionType];
  if (known) return { label: known.label, reason: known.reason ?? NOT_BROUGHT, known: true };
  return { label: notionType || "Notion block", reason: NOT_BROUGHT, known: false };
}
