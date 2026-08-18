/**
 * What a context file may be, decided once. The picker's accept list, the
 * upload check and the extractor all read these — pure helpers with no function
 * registrations, so the default-runtime module and the Node extractor can both
 * import them without dragging each other's runtime along.
 */

/** Room for a real report; a PDF past this is a scan, not a document. */
export const MAX_FILE_BYTES = 10_000_000;
/** Enough of a file to reason about — the same cap a repo file read gets. */
export const MAX_FILE_TEXT = 60_000;
/** The head read into every prompt; the same slice a README gets. */
export const FILE_HEAD = 1500;

export type FileKind = "pdf" | "docx" | "html" | "text";

/**
 * Extension first, media type second: browsers report no type at all for most
 * of these — a `.md` file routinely arrives as `""` — so the name is the more
 * reliable of the two.
 */
const BY_EXTENSION: Record<string, FileKind> = {
  pdf: "pdf",
  docx: "docx",
  html: "html",
  htm: "html",
  md: "text",
  markdown: "text",
  txt: "text",
};

const BY_TYPE: Record<string, FileKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/html": "html",
  "text/markdown": "text",
  "text/plain": "text",
};

/** How this file will be read, or null for a kind that cannot be. */
export function fileKind(filename: string, mediaType: string): FileKind | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? BY_TYPE[mediaType] ?? null;
}

/** The picker's filter, from the same tables the check reads, so they agree. */
export const CONTEXT_FILE_ACCEPT = [
  ...Object.keys(BY_EXTENSION).map((ext) => `.${ext}`),
  ...Object.keys(BY_TYPE),
].join(",");

/** Named for the message the user reads when a file is refused. */
export const CONTEXT_FILE_HELP =
  "Context files can be PDF, Word (.docx), Markdown, HTML or plain text.";

/**
 * An HTML page as words. Deliberately not a DOM parse: this runs in the
 * extractor, where the only job is to keep the prose and lose the markup —
 * scripts and styles go whole, block boundaries become line breaks, and the
 * handful of entities that appear in real pages are decoded.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\s*(?:br|hr)\s*\/?\s*>/gi, "\n")
    .replace(
      /<\/\s*(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|table|ul|ol|dd|dt)\s*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, decodeEntity)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

/** The entities real prose actually uses; anything unknown is left as typed. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", trade: "™", deg: "°", times: "×",
};

function decodeEntity(entity: string, name: string): string {
  const lower = name.toLowerCase();
  if (lower in ENTITIES) return ENTITIES[lower];
  if (!lower.startsWith("#")) return entity;
  const code = lower.startsWith("#x")
    ? parseInt(lower.slice(2), 16)
    : parseInt(lower.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
}
