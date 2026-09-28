import type { SeedBlock } from "@/app/lib/onboarding/types";

/**
 * The few block shapes every template writes, so a page reads as its copy
 * rather than as the structure BlockNote wants around it.
 */

/** A table cell: inline content, which is what both the editor and the
 *  thumbnail read. */
export const cell = (text: string) => [{ type: "text" as const, text, styles: {} }];

/** A table whose first row is its header. */
export const table = (...rows: string[][]): SeedBlock => ({
  type: "table",
  content: {
    type: "tableContent",
    headerRows: 1,
    rows: rows.map((row) => ({ cells: row.map(cell) })),
  },
});

export const h2 = (text: string): SeedBlock => ({
  type: "heading",
  props: { level: 2 },
  content: text,
});

export const h3 = (text: string): SeedBlock => ({
  type: "heading",
  props: { level: 3 },
  content: text,
});

export const p = (text: string): SeedBlock => ({ type: "paragraph", content: text });

export const bullet = (text: string): SeedBlock => ({ type: "bulletListItem", content: text });

export const check = (text: string, checked = false): SeedBlock => ({
  type: "checkListItem",
  props: { checked },
  content: text,
});

/** The rich blocks all store their whole value as one markup string. */
export const canvas = (data: string): SeedBlock => ({ type: "canvas", props: { data } });
export const album = (data: string): SeedBlock => ({ type: "album", props: { data } });
export const storyboard = (data: string): SeedBlock => ({ type: "storyboard", props: { data } });
export const location = (data: string): SeedBlock => ({ type: "location", props: { data } });

export const numbered = (text: string): SeedBlock => ({ type: "numberedListItem", content: text });

export const quote = (text: string): SeedBlock => ({ type: "quote", content: text });

/** A toggle, folded over whatever it holds. */
export const toggle = (text: string, ...children: SeedBlock[]): SeedBlock => ({
  type: "toggleListItem",
  content: text,
  children,
});

/** One row per line; each line is typeset on its own. */
export const maths = (...lines: string[]): SeedBlock => ({
  type: "mathBlock",
  props: { source: lines.join("\n") },
});

export const code = (language: string, source: string): SeedBlock => ({
  type: "codeBlock",
  props: { language, code: source },
});

/** A line of prose with maths in it: strings are text, `$(…)` is inline maths. */
export const $ = (latex: string) => ({ type: "math" as const, props: { latex } });
export const prose = (...parts: (string | ReturnType<typeof $>)[]): SeedBlock => ({
  type: "paragraph",
  content: parts.map((part) =>
    typeof part === "string" ? { type: "text" as const, text: part, styles: {} } : part,
  ),
});
