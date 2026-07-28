/**
 * The auto-board document language.
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
 *  3. Only genuinely novel constructs get an `ab-` custom element. (Hyphenated
 *     custom elements are valid HTML — the Custom Elements spec requires the
 *     hyphen — so every parser handles them.)
 *
 * `id` carries the whole insert/update distinction: an element WITH an id
 * updates that block, an element WITHOUT one inserts a new block.
 */

/** Elements whose content is code/LaTeX and must never be read as markup. */
export const RAW_TEXT_TAGS = [
  "ab-code-block",
  "code-block",
  "codeblock",
  "ab-math-line",
  "math-line",
] as const;

/**
 * We emit one canonical name per construct but accept the plausible variants a
 * model reaches for. Strict in what we write, liberal in what we read: a model
 * writing `<code-block>` instead of `<ab-code-block>` is a naming preference,
 * not an error, and silently dropping it would look like the feature failing.
 */
export const TAG_ALIASES: Record<string, string> = {
  "code-block": "ab-code-block",
  codeblock: "ab-code-block",
  "math-block": "ab-math-block",
  mathblock: "ab-math-block",
  "math-line": "ab-math-line",
  diagram: "ab-diagram",
  flowchart: "ab-diagram",
  node: "ab-node",
  edge: "ab-edge",
  math: "ab-math",
};

/** Canonical tag name for an element, resolving accepted aliases. */
export function canonicalTag(tag: string): string {
  const t = tag.toLowerCase();
  return TAG_ALIASES[t] ?? t;
}

export type Mark = "bold" | "italic" | "underline" | "strike" | "code";

export type Run =
  | { type: "text"; text: string; marks?: Mark[] }
  | { type: "math"; latex: string };

export type ShapeKind = "rectangle" | "ellipse" | "diamond" | "text";

export type DocNode =
  | {
      type:
        | "paragraph"
        | "heading"
        | "bulletListItem"
        | "numberedListItem"
        | "checkListItem"
        | "quote";
      id?: string;
      level?: number;
      checked?: boolean;
      content: Run[];
      /** Nested list items — an indented outline. */
      children?: DocNode[];
    }
  | { type: "codeBlock"; id?: string; language: string; code: string }
  | { type: "mathBlock"; id?: string; rows: string[] }
  | {
      type: "canvas";
      id?: string;
      nodes: Array<{
        id?: string;
        shape: ShapeKind;
        label: string;
        x?: number;
        y?: number;
      }>;
      edges: Array<{ from: string; to: string; label?: string }>;
    };

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
  "ab-math", "br",
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
