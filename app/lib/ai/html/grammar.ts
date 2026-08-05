/**
 * The Nootles document language.
 *
 * A small HTML dialect that the model reads and writes. The bet: models are
 * saturated with HTML and treat *tag names* as structural, so a grammar built
 * from tags is far more reliably produced than one built from class attributes
 * (which models treat as decorative styling noise).
 *
 * Three rules govern it:
 *  1. A standard element with the right semantics is used as-is (`<p>`, `<ul>`,
 *     `<code>` for INLINE code, `<blockquote>`…).
 *  2. A variant of a standard element is that element plus a `data-` attribute.
 *  3. Only genuinely novel constructs get an `nt-` custom element. (Hyphenated
 *     custom elements are valid HTML — the Custom Elements spec requires the
 *     hyphen — so every parser handles them.)
 *
 * `id` carries the whole insert/update distinction: an element WITH an id
 * updates that block, an element WITHOUT one inserts a new block.
 */

/** Elements whose content is code/LaTeX and must never be read as markup. */
export const RAW_TEXT_TAGS = [
  "nt-code-block",
  "code-block",
  "codeblock",
  "nt-math-line",
  "math-line",
] as const;

/**
 * We emit one canonical name per construct but accept the plausible variants a
 * model reaches for. Strict in what we write, liberal in what we read: a model
 * writing `<code-block>` instead of `<nt-code-block>` is a naming preference,
 * not an error, and silently dropping it would look like the feature failing.
 */
export const TAG_ALIASES: Record<string, string> = {
  "code-block": "nt-code-block",
  codeblock: "nt-code-block",
  "math-block": "nt-math-block",
  mathblock: "nt-math-block",
  "math-line": "nt-math-line",
  diagram: "nt-diagram",
  flowchart: "nt-diagram",
  math: "nt-math",
  file: "nt-file",
  attachment: "nt-file",
  ref: "nt-ref",
  "page-ref": "nt-ref",
  mention: "nt-ref",
};

/** Canonical tag name for an element, resolving accepted aliases. */
export function canonicalTag(tag: string): string {
  const t = tag.toLowerCase();
  return TAG_ALIASES[t] ?? t;
}

export type Mark = "bold" | "italic" | "underline" | "strike" | "code";

export type TextRun = { type: "text"; text: string; marks?: Mark[] };

/**
 * `<a href>` is a run rather than a mark, because a destination is not a style:
 * two adjacent links are two links, and merging them the way marks merge would
 * lose one of the hrefs. Its content is text only — that is what the editor can
 * hold — so the write half can express exactly what the read half emits.
 */
export type Run =
  | TextRun
  | { type: "math"; latex: string }
  | { type: "link"; href: string; content: TextRun[] }
  /**
   * `<nt-ref page="…">Title</nt-ref>` — a mention of another page. Like a
   * link it carries a destination, so it is a run and not a mark; the text is
   * the title as it read when written, a fallback the UI overrides live.
   */
  | { type: "pageRef"; pageId: string; title: string };

export type DocNode =
  | {
      type:
        | "paragraph"
        | "heading"
        | "bulletListItem"
        | "numberedListItem"
        | "checkListItem"
        | "toggleListItem"
        | "quote";
      id?: string;
      level?: number;
      checked?: boolean;
      /** First number of an `<ol start="5">`. */
      start?: number;
      content: Run[];
      /** Nested list items — an indented outline. */
      children?: DocNode[];
    }
  | {
      type: "table";
      id?: string;
      /** First row is a header row when true — `<th>` rather than `<td>`. */
      header?: boolean;
      /** rows[r][c] is one cell's runs. */
      rows: Run[][][];
    }
  | { type: "codeBlock"; id?: string; language: string; code: string }
  | { type: "mathBlock"; id?: string; rows: string[] }
  /** `<hr>` — nothing to carry but its position. */
  | { type: "divider"; id?: string }
  /**
   * Media. All four are the same shape, and all four are standard elements
   * except the file, which has no standard equivalent that means "an attachment
   * sitting in the document" — `<a download>` is a link, not a block.
   */
  | {
      type: "image" | "video" | "audio" | "file";
      id?: string;
      /** Absent means the source was not stated — the block keeps the one it has. */
      url?: string;
      /** `alt` on an image, the visible label on a file. */
      caption?: string;
      name?: string;
    }
  /**
   * A diagram, carried as the `<nt-diagram>` markup itself.
   *
   * Every other block is normalized into fields because the compiler diffs it
   * field by field. A canvas is not: the block already STORES this grammar, so
   * the shapes, their geometry and their CSS have exactly one representation
   * and re-modelling it here could only lose something. See
   * `app/components/editor/canvas/scene/` for the parser both halves share.
   */
  | { type: "canvas"; id?: string; html: string };

/**
 * Content words shared between two texts, as a share of the completion's own.
 *
 * The cheap stand-in for "could this have been inferred from the page?".
 * Codestral's FIM endpoint refuses logprobs ("Logprobs are not enabled for
 * this model"), so there is no token confidence to read; overlap with what the
 * page already says is the next best thing, and it separated invention from
 * inference cleanly when measured.
 */
export function grounding(pageText: string, completion: string): number {
  const words = (s: string) => s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  const have = new Set(words(pageText));
  const w = words(completion);
  if (!w.length) return 1; // punctuation or a word ending — nothing invented
  return w.filter((x) => have.has(x)).length / w.length;
}

/** Inline marks ⇄ their standard HTML elements. `code` is INLINE code. */
export const MARK_TAGS: Record<Mark, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  code: "code",
};

/**
 * Tags that live INSIDE a paragraph. A completion containing one of these is
 * still prose — it is not opening a new block.
 *
 * Without this distinction "the <code>maxRetries</code> option controls…" was
 * read as structural markup and truncated at </code>, so inline code in a
 * suggestion came back as a mangled half-sentence.
 */
export const INLINE_TAGS = new Set([
  "strong", "b", "em", "i", "u", "s", "code", "a", "span", "sup", "sub",
  "nt-math", "nt-ref", "br",
]);

export const TAG_TO_MARK: Record<string, Mark> = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  u: "underline",
  s: "strike",
  strike: "strike",
  del: "strike",
  code: "code",
};
