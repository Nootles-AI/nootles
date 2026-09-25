/**
 * What a character typed at the end of `before` turns into, Notion's way.
 *
 * `before` is the block's text up to the caret, with every inline leaf (a
 * mention, an equation, a checkbox) standing in as one U+FFFC, so a count of
 * characters is also a count of document positions. `length` always runs back
 * from the end of `before + typed` and includes the typed character.
 */
export type InlineShortcut =
  | { kind: "text"; length: number; text: string }
  | { kind: "strike"; length: number }
  | { kind: "math"; length: number; latex: string };

export const LEAF = "￼";

/**
 * Longest stretch a shortcut reads back over — `~…~` and `$$…$$` close
 * something opened earlier on the line. Bounded so a keystroke costs the same
 * in a long paragraph as in a short one.
 */
export const LOOKBEHIND = 400;

const SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["->", "→"],
  ["<-", "←"],
  ["--", "—"],
  ["=>", "⇒"],
  ["...", "…"],
  ["<=", "≤"],
  [">=", "≥"],
  ["!=", "≠"],
];

// Opened at the start of a word, closed on a character that isn't space, and
// never one of `~~…~~`'s tildes: the second `~` of a pair has a `~` before it.
const STRIKE = /(?:^|\s)~([^~\s](?:[^~]*[^~\s])?)$/;
const MATH = /(?:^|[^$\\])\$\$([^$]+)\$$/;

export function inlineShortcut(before: string, typed: string): InlineShortcut | null {
  if (typed.length !== 1) return null;

  if (typed === "~") {
    const match = STRIKE.exec(before);
    if (!match || match[1].includes(LEAF)) return null;
    return { kind: "strike", length: match[1].length + 2 };
  }

  if (typed === "$") {
    const match = MATH.exec(before);
    const latex = match?.[1].trim();
    if (!match || !latex || latex.includes(LEAF)) return null;
    return { kind: "math", length: match[1].length + 4, latex };
  }

  const text = before + typed;
  // A line of nothing but dashes is on its way to `---`, the divider.
  if (typed === "-" && /^-+$/.test(text)) return null;
  for (const [from, to] of SYMBOLS) {
    if (text.endsWith(from)) return { kind: "text", length: from.length, text: to };
  }
  return null;
}
