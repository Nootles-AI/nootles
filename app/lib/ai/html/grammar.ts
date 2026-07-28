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
export const RAW_TEXT_TAGS = ["ab-code-block", "ab-math-line"] as const;

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

/** Inline marks ⇄ their standard HTML elements. `code` is INLINE code. */
export const MARK_TAGS: Record<Mark, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  code: "code",
};

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
