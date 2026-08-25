import type { LineResult } from "./engine";

/**
 * The evaluated column, stored beside the LaTeX so a reader sees the values the
 * author saw without loading the compute engine to re-derive them.
 *
 * Stamped with a hash of the source it was computed from, because it can
 * outlive it: an AI op writes a block's rows and nothing else (`setMathRows`),
 * and a value belonging to a row that has since changed is worse than one that
 * arrives a beat late. A stamp that does not match is no column at all.
 */

function stamp(source: string): string {
  let h = 5381;
  for (let i = 0; i < source.length; i++) {
    h = ((h << 5) + h + source.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** An error, told apart from a value: no LaTeX for a number opens with `!`. */
const ERROR = "!";

/** One line per row, so a value carrying a break in it is flattened onto one. */
const cell = (r: LineResult): string =>
  (r.error ? ERROR + r.error : (r.valueLatex ?? "")).replace(/\s*\n\s*/g, " ");

export function encodeResults(source: string, results: LineResult[]): string {
  if (!results.length) return "";
  return [stamp(source), ...results.map(cell)].join("\n");
}

export function decodeResults(
  source: string,
  stored: string,
): LineResult[] | null {
  if (!stored) return null;
  const [mark, ...rows] = stored.split("\n");
  if (mark !== stamp(source)) return null;
  return rows.map((row) => ({
    name: null,
    valueLatex: row.startsWith(ERROR) || !row ? null : row,
    error: row.startsWith(ERROR) ? row.slice(1) : null,
    empty: !row,
  }));
}
