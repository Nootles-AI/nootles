import { BLOCK_TYPES, type BlockType } from "./ai/operations";

/**
 * A page reduced to the little of it a thumbnail can show.
 *
 * The projects grid draws a miniature of each project's first page, the way a
 * file manager draws a document's first sheet. That is a *recognition* aid —
 * you are looking for the shape of a page you have seen before — so it needs
 * the block structure and the opening words of each line, and nothing else.
 * No marks, no links, no attributes, no nesting.
 *
 * Trimmed here rather than in the client because the alternative is shipping
 * every project's whole document to render a card two inches tall.
 */
export type PreviewLine = { type: BlockType; text: string };

/** Enough to fill the tallest card; the client shows fewer. */
const MAX_LINES = 12;
/** A line longer than the card is wide is cropped by CSS anyway. */
const MAX_CHARS = 120;

const KNOWN = new Set<string>(BLOCK_TYPES);

/**
 * The text a node carries, from its own `text` fields and its children's.
 *
 * ProseMirror stores a paragraph's words as a list of text nodes carrying
 * marks, so the words are always one level down at least, and inline math or a
 * link puts them further. Walking for them is what makes this independent of
 * which inline specs the schema happens to have.
 */
function textOf(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const n = node as { text?: unknown; content?: unknown };
  if (typeof n.text === "string") out.push(n.text);
  if (Array.isArray(n.content)) for (const child of n.content) textOf(child, out);
  return out;
}

/**
 * Walks the stored document, emitting one line per block it recognises.
 *
 * Deliberately a search for known block types rather than a walk of a known
 * shape: BlockNote wraps every block in a `blockContainer` inside a
 * `blockGroup`, and nests a list item's children in another `blockGroup` below
 * it. Matching on the type means the nesting can change without this noticing,
 * and an unknown block contributes its children rather than swallowing them.
 */
function collect(node: unknown, out: PreviewLine[]): void {
  if (out.length >= MAX_LINES || !node || typeof node !== "object") return;
  const n = node as { type?: unknown; content?: unknown };

  if (typeof n.type === "string" && KNOWN.has(n.type)) {
    const text = textOf(n.content).join("").replace(/\s+/g, " ").trim();
    // A void block — a diagram, a divider, an image — has no words but is very
    // much part of the page's shape, so it earns a line with an empty string.
    out.push({ type: n.type as BlockType, text: text.slice(0, MAX_CHARS) });
    // Its own content is the text just taken. A list item's nested children are
    // NOT in here — BlockNote puts them in a group beside this node, which the
    // parent's loop reaches next.
    return;
  }

  if (Array.isArray(n.content)) for (const child of n.content) collect(child, out);
}

/**
 * `content` is the stringified ProseMirror JSON `getSnapshot` returns, or null
 * for a page that has never been saved. Malformed JSON yields no preview rather
 * than throwing: a thumbnail is not worth failing a page list over.
 */
export function previewFromSnapshot(content: string | null): PreviewLine[] {
  if (!content) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return [];
  }
  const out: PreviewLine[] = [];
  collect(doc, out);
  // A trailing empty paragraph is what an editor leaves under everything you
  // wrote; it is not a line of the document.
  while (out.length && out[out.length - 1].type === "paragraph" && !out[out.length - 1].text) {
    out.pop();
  }
  return out;
}
