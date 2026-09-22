/**
 * A Notion page's blocks as plain text, for the context graph.
 *
 * Not the importer's converter (`app/lib/notion/convert.ts`), which keeps
 * everything a page draws with. Context wants the words and enough of their
 * shape to read: headings as lines of their own, list items marked and
 * indented, a table as rows. The block tree is `pages.children`'s — Notion's
 * own JSON, with each block's children read into `children`.
 */

export type RichText = { plain_text?: string };

export type NotionBlock = {
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [payload: string]: unknown;
};

/** The payload fields this reads; any block type may carry some of them. */
type Payload = {
  rich_text?: RichText[];
  caption?: RichText[];
  checked?: boolean;
  expression?: string;
  title?: string;
  cells?: RichText[][];
  icon?: { type?: string; emoji?: string } | null;
};

const HEADINGS = new Set(["heading_1", "heading_2", "heading_3"]);
const LIST_ITEMS = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);
/** Blocks that are only a frame for their children, which read as the parent's. */
const TRANSPARENT = new Set(["column_list", "column", "synced_block"]);
const MEDIA = new Set(["image", "file", "pdf", "video", "audio"]);

export function flattenBlocks(blocks: NotionBlock[]): { text: string; headings: string[] } {
  const headings: string[] = [];
  const text = sequence(blocks, false, headings)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, headings };
}

/**
 * Blocks one after another. At the top of a page each is a paragraph of its
 * own; a run of list items stays together, as it does on the page. Nested
 * under something, they are lines.
 */
function sequence(blocks: NotionBlock[], nested: boolean, headings: string[]): string {
  let out = "";
  let previous: string | undefined;
  let ordinal = 0;
  for (const block of spliced(blocks)) {
    ordinal = block.type === "numbered_list_item" ? ordinal + 1 : 0;
    const piece = render(block, ordinal, headings);
    if (!piece) continue;
    if (out) {
      const run = previous !== undefined && LIST_ITEMS.has(previous) && LIST_ITEMS.has(block.type);
      out += nested || run ? "\n" : "\n\n";
    }
    out += piece;
    previous = block.type;
  }
  return out;
}

function spliced(blocks: NotionBlock[]): NotionBlock[] {
  return blocks.flatMap((block) =>
    TRANSPARENT.has(block.type) ? spliced(block.children ?? []) : [block],
  );
}

function render(block: NotionBlock, ordinal: number, headings: string[]): string {
  const payload = (block[block.type] ?? {}) as Payload;
  const own = plain(payload.rich_text);

  if (block.type === "table") {
    return (block.children ?? [])
      .filter((row) => row.type === "table_row")
      .map((row) => ((row.table_row ?? {}) as Payload).cells?.map(plain).join(" | ") ?? "")
      .filter(Boolean)
      .join("\n");
  }
  if (block.type === "child_page") return `(page: ${payload.title || "Untitled"})`;
  if (block.type === "child_database") return `(database: ${payload.title || "Untitled"})`;

  let line: string;
  if (HEADINGS.has(block.type)) {
    if (own.trim()) headings.push(own.trim());
    line = own;
  } else if (!own.trim() && LIST_ITEMS.has(block.type)) line = "";
  else if (block.type === "bulleted_list_item") line = `- ${own}`;
  else if (block.type === "numbered_list_item") line = `${ordinal}. ${own}`;
  else if (block.type === "to_do") line = `${payload.checked ? "[x]" : "[ ]"} ${own}`;
  else if (block.type === "quote") line = own && own.replace(/^/gm, "> ");
  else if (block.type === "callout") {
    const emoji = payload.icon?.type === "emoji" ? payload.icon.emoji : undefined;
    line = own && (emoji ? `${emoji} ${own}` : own);
  } else if (block.type === "equation") line = payload.expression ?? "";
  else if (block.type === "divider") line = "";
  else if (MEDIA.has(block.type)) line = plain(payload.caption);
  else line = own;

  const kids = block.children?.length ? sequence(block.children, true, headings) : "";
  if (!kids) return line;
  const below = LIST_ITEMS.has(block.type) ? kids.replace(/^/gm, "  ") : kids;
  return line ? `${line}\n${below}` : below;
}

function plain(runs: RichText[] | undefined): string {
  return (runs ?? []).map((run) => run.plain_text ?? "").join("");
}
