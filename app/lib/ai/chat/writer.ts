/**
 * The writer's section, as it is stored and placed.
 *
 * The agent plans and the writer drafts (`write` in `serverTools`); the section
 * waits in the holding pen the draw tool uses, under a ref, until `edit_page`
 * places it with `<nt-section ref>`. These are the pure parts of that trip, kept
 * loadable by both sides: the server names and cleans what the writer returned,
 * and the browser finds the refs to redeem.
 */

/** `<nt-section ref="w…"></nt-section>`, as the agent places a section. */
export const SECTION_REF = /<nt-section\b[^>]*\bref="([^"]+)"[^>]*>\s*<\/nt-section\s*>/gi;

/** Blocks as the agent reads and writes them — the elements an id on which is a block id. */
const BLOCK_TAG =
  /<(p|h[1-6]|ul|ol|li|blockquote|hr|table|thead|tbody|tr|th|td|details|summary|img|nt-code-block|nt-math-block|nt-diagram)\b([^>]*)>/gi;

/** Where the dialect keeps raw text, which is never markup to clean. */
const RAW = /<nt-code-block\b[\s\S]*?<\/nt-code-block\s*>|<nt-math-block\b[\s\S]*?<\/nt-math-block\s*>/gi;

/**
 * The writer's reply as a section the agent can place: the fence a model wraps
 * HTML in taken off, and every block id or `at` removed. The writer is told to
 * write none, but one slipping through would read to `edit_page` as a rewrite
 * of a block the page does not have, and the whole placement would be refused.
 * A diagram's shapes keep theirs — edges name shapes by id. Code and maths are
 * raw text and left exactly as written.
 */
export function cleanSection(reply: string): string {
  const html = reply
    .trim()
    .replace(/^```[a-z]*\s*\n/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  let out = "";
  let last = 0;
  for (const raw of html.matchAll(RAW)) {
    out += unId(html.slice(last, raw.index)) + unIdOpening(raw[0]);
    last = raw.index + raw[0].length;
  }
  return out + unId(html.slice(last));
}

function unId(markup: string): string {
  return markup.replace(BLOCK_TAG, (_whole, tag: string, attrs: string) => `<${tag}${strip(attrs)}>`);
}

/** A code or maths block: only its opening tag is markup. */
function unIdOpening(block: string): string {
  return block.replace(/^<([a-z-]+)([^>]*)>/i, (_whole, tag: string, attrs: string) => `<${tag}${strip(attrs)}>`);
}

function strip(attrs: string): string {
  return attrs.replace(/\s(?:id|at)="[^"]*"/gi, "");
}

/** The writer's closing list of what it kept without a source behind it. */
const UNSOURCED = /<!--\s*unsourced:([\s\S]*?)-->/i;

/**
 * A stored section, split into what goes on the page and what the writer
 * flagged. The flags are kept in the stored section rather than beside it, so
 * a retry answered from the holding pen reports them too.
 */
export function splitSection(stored: string): { html: string; unsourced: string[] } {
  const found = UNSOURCED.exec(stored);
  if (!found) return { html: stored, unsourced: [] };
  const unsourced = found[1]
    .split(/\n|\|/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  return { html: stored.replace(UNSOURCED, "").trim(), unsourced };
}

/** What the agent is told a section holds: its headings, and how much of what. */
export function outlineOf(html: string): { headings: string[]; blocks: number; diagrams: number } {
  const bare = html.replace(RAW, "<nt-code-block></nt-code-block>");
  const headings = [...bare.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );
  // Top-level only: a diagram's shapes and a table's cells are not blocks.
  const depthless = bare
    .replace(/<nt-diagram\b[\s\S]*?<\/nt-diagram\s*>/gi, "<nt-diagram></nt-diagram>")
    .replace(/<table\b[\s\S]*?<\/table\s*>/gi, "<table></table>")
    .replace(/<(ul|ol)\b[\s\S]*?<\/\1\s*>/gi, "<$1></$1>")
    .replace(/<details\b[\s\S]*?<\/details\s*>/gi, "<details></details>");
  const blocks = (
    depthless.match(/<(p|h[1-6]|ul|ol|blockquote|hr|table|details|img|nt-code-block|nt-math-block|nt-diagram)\b/gi) ?? []
  ).length;
  const diagrams = (bare.match(/<nt-diagram\b/gi) ?? []).length;
  return { headings, blocks, diagrams };
}
