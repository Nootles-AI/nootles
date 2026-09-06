/**
 * Recognising a link that points at a Notion page.
 *
 * An imported page keeps its links to pages you did not import — that is the
 * honest thing for the document to hold, and it stays a working link whatever
 * happens next. What this function buys is the offer: a link we can name a page
 * id inside is one we can import on request, so it is worth asking rather than
 * just leaving the workspace.
 *
 * Deliberately matches any notion.so URL, not only the ones this importer
 * wrote. A Notion link pasted by hand is the same offer, and treating it
 * differently because of where it came from would be a distinction the reader
 * cannot see.
 */

const HOSTS = new Set(["notion.so", "www.notion.so", "notion.site"]);
/** Notion ids are 32 hex characters, dashed in the API and bare in its URLs. */
const ID = /([0-9a-f]{32})$/i;

export function notionPageIdFrom(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host) && !host.endsWith(".notion.site")) return null;

  // A fragment addresses a block inside a page, not the page. Notion writes
  // these for a link to a specific block, and this importer writes one for
  // every stub it leaves behind — a database, a template, a block type we do
  // not know. None of those is a page that could be imported, so none of them
  // is worth offering to import.
  if (url.hash) return null;

  // The id is the tail of the last path segment, after any title slug:
  // /Some-Page-Title-1a2b…  and  /1a2b… are both ordinary.
  const last = url.pathname.split("/").filter(Boolean).pop();
  const bare = last?.split("-").pop();
  const match = bare ? ID.exec(bare) : null;
  return match ? dash(match[1].toLowerCase()) : null;
}

/**
 * A link to a block inside a Notion page — what every stub this importer
 * leaves behind points at. Not a page, so never an import offer; but still
 * ours to open, because handing the click back to the editor is what raises
 * the link toolbar over a thing nobody should be editing.
 */
export function isNotionBlockHref(href: string): boolean {
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase();
    if (!HOSTS.has(host) && !host.endsWith(".notion.site")) return false;
    return url.hash.length > 1;
  } catch {
    return false;
  }
}

/** The dashed form the API answers to. */
function dash(id: string): string {
  return [
    id.slice(0, 8),
    id.slice(8, 12),
    id.slice(12, 16),
    id.slice(16, 20),
    id.slice(20),
  ].join("-");
}
