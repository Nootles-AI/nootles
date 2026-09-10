/**
 * The Notion shapes this importer reads, and nothing more.
 *
 * These are deliberately *not* exhaustive models of the Notion API. Notion's
 * block set is open — integrations and new first-party blocks arrive without
 * warning — so a closed union here would be a lie that `tsc` would happily
 * believe. A block is therefore an id, a type string, and an opaque payload;
 * everything narrower is read through the guards below, which answer "is this
 * really a rich-text array" at runtime rather than trusting a cast.
 */

export type NotionColor = string;

export type NotionAnnotations = {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: NotionColor;
};

/** A Notion file reference. `file` URLs are signed and expire in about an hour. */
export type NotionFile =
  | { type: "file"; file: { url: string; expiry_time?: string } }
  | { type: "external"; external: { url: string } };

export type NotionIcon = { type: "emoji"; emoji: string } | NotionFile;

export type NotionMention =
  | { type: "user"; user: { id: string; name?: string } }
  | { type: "page"; page: { id: string } }
  | { type: "database"; database: { id: string } }
  | { type: "date"; date: { start: string; end?: string | null } }
  | { type: "link_preview"; link_preview: { url: string } }
  | { type: "template_mention"; template_mention: unknown };

export type NotionRichText = {
  type?: string;
  plain_text: string;
  href?: string | null;
  annotations?: Partial<NotionAnnotations>;
  text?: { content: string; link?: { url: string } | null };
  equation?: { expression: string };
  mention?: NotionMention;
};

/**
 * A block as it reaches the converter: the Notion row, plus the children the
 * fetcher already walked. Notion returns children through a separate paginated
 * call, so assembling the tree is the fetcher's job and the converter stays
 * pure.
 */
export type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
} & { [key: string]: unknown };

export type NotionPage = {
  id: string;
  icon?: NotionIcon | null;
  cover?: NotionFile | null;
  properties?: Record<string, unknown>;
  url?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The payload Notion hangs under the block's own type key. */
export function payloadOf(block: NotionBlock): Record<string, unknown> {
  const payload = block[block.type];
  return isRecord(payload) ? payload : {};
}

export function richTextAt(payload: Record<string, unknown>, key = "rich_text"): NotionRichText[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is NotionRichText => isRecord(item) && typeof item.plain_text === "string",
  );
}

export function stringAt(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

export function booleanAt(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

export function numberAt(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The URL out of a Notion file object, and whether it is the expiring kind. */
export function fileAt(
  payload: Record<string, unknown>,
  key?: string,
): { url: string; expiring: boolean } | undefined {
  const holder = key === undefined ? payload : payload[key];
  if (!isRecord(holder)) return undefined;
  const external = holder.external;
  if (isRecord(external) && typeof external.url === "string") {
    return { url: external.url, expiring: false };
  }
  const file = holder.file;
  if (isRecord(file) && typeof file.url === "string") {
    return { url: file.url, expiring: true };
  }
  return undefined;
}

export function iconOf(page: NotionPage): { emoji?: string; url?: string } {
  const icon = page.icon;
  if (!isRecord(icon)) return {};
  if (icon.type === "emoji" && typeof icon.emoji === "string") return { emoji: icon.emoji };
  return { url: fileAt(icon)?.url };
}

/** Notion ids are dashed UUIDs; its own URLs use the undashed form. */
export function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}
