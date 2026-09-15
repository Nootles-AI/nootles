/**
 * Colour-shaped tokens inside an arbitrary CSS value, by character span.
 *
 * `panels/selectionColors.ts` needs this to rewrite every use of one colour
 * across a whole subtree's declarations without touching anything else the
 * declaration says — a `background: linear-gradient(90deg, var(--a) 0%, #fff
 * 100%)` recolour must leave `linear-gradient(90deg, …, … 100%)` untouched
 * and only the two colour tokens replaced. Named CSS colours (`red`) and bare
 * keywords (`cover`, `left`) are deliberately NOT tokens: `background: left
 * center` would otherwise have `left` mistaken for a colour called "left".
 */

export interface ColorToken {
  start: number;
  end: number;
  text: string;
}

/** Colour function names this tokenizer recognises the shape of. `var()` is
 *  matched separately below, as a whole reference (never partially). */
const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)$/i;

const HEX = /#[0-9a-f]{3,8}\b/gi;
const KEYWORD = /\b(transparent|currentcolor)\b/gi;
/** Global, not sticky: this has to search forward for the next identifier
 *  wherever it falls, not only match one sitting exactly at `lastIndex`. */
const IDENT = /-?[a-zA-Z_][\w-]*/g;

/** The matching `)` for the `(` at `openAt`, honouring nesting (a `color()`
 *  can nest nothing today, but `var(--x, rgb(0 0 0))` nests one level). */
function matchParen(css: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < css.length; i++) {
    if (css[i] === "(") depth++;
    else if (css[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length - 1;
}

/** Character ranges to skip entirely: quoted strings and `url(...)` — a font
 *  name or an image address must never be scanned for colour-looking text. */
function maskedRanges(css: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const quote = /["']/g;
  let m: RegExpExecArray | null;
  while ((m = quote.exec(css))) {
    const q = m[0];
    const end = css.indexOf(q, m.index + 1);
    ranges.push([m.index, end < 0 ? css.length : end + 1]);
    quote.lastIndex = end < 0 ? css.length : end + 1;
  }
  const url = /\burl\(/gi;
  while ((m = url.exec(css))) {
    const open = m.index + m[0].length - 1;
    ranges.push([m.index, matchParen(css, open) + 1]);
  }
  return ranges;
}

function masked(ranges: Array<[number, number]>, at: number): boolean {
  return ranges.some(([a, b]) => at >= a && at < b);
}

/**
 * Every colour-shaped token in `css`, left to right, outside quotes and
 * `url()`: `#hex`, `rgb[a]()`, `hsl[a]()`, `hwb()`, `lab()`, `lch()`,
 * `oklab()`, `oklch()`, `color()`, `var(--x[, fallback])` (the whole
 * reference, one token), `transparent`, `currentcolor`. Named colours are not
 * tokens. Nested parens are handled by {@link matchParen}.
 */
export function findColorTokens(css: string): ColorToken[] {
  const skip = maskedRanges(css);
  const out: ColorToken[] = [];

  HEX.lastIndex = 0;
  for (let m = HEX.exec(css); m; m = HEX.exec(css)) {
    if (!masked(skip, m.index)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }

  KEYWORD.lastIndex = 0;
  for (let m = KEYWORD.exec(css); m; m = KEYWORD.exec(css)) {
    if (!masked(skip, m.index)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }

  // Function-shaped tokens: an identifier immediately followed by `(`.
  IDENT.lastIndex = 0;
  for (let m = IDENT.exec(css); m; m = IDENT.exec(css)) {
    const start = m.index;
    const name = m[0];
    const openAt = start + name.length;
    if (css[openAt] !== "(") continue;
    if (masked(skip, start)) continue;
    const isVar = name.toLowerCase() === "var";
    if (!isVar && !COLOR_FN.test(name)) continue;
    const close = matchParen(css, openAt);
    out.push({ start, end: close + 1, text: css.slice(start, close + 1) });
    IDENT.lastIndex = close + 1;
  }

  out.sort((a, b) => a.start - b.start);
  // A function match and a bare hex/keyword can never overlap (a colour
  // function's own arguments are never re-scanned as top-level text by the
  // sticky IDENT pass), so de-duplication is unnecessary — but a defensive
  // sort by start keeps callers that assume left-to-right order safe.
  return out;
}

/** `css` with the tokens at `spans` replaced by `by(token)`, byte-preserving
 *  everywhere else. `spans` must be sorted left to right (as
 *  {@link findColorTokens} returns them) and non-overlapping. */
export function replaceColorTokens(
  css: string,
  spans: readonly ColorToken[],
  by: (token: ColorToken) => string,
): string {
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += css.slice(cursor, span.start) + by(span);
    cursor = span.end;
  }
  return out + css.slice(cursor);
}
