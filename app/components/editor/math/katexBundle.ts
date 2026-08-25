import katex from "katex";
import "katex/dist/katex.min.css";

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/**
 * KaTeX and its stylesheet, reached only through `katex.ts`'s dynamic import —
 * the two of them are ~300KB that the editor's schema would otherwise put on
 * every page, maths or no maths.
 */
export function renderLatex(latex: string): string {
  try {
    return katex.renderToString(latex, { throwOnError: false });
  } catch {
    // Malformed past what `throwOnError: false` can draw: the source, which is
    // what the row was showing anyway.
    return latex.replace(/[&<>]/g, (c) => ESCAPE[c]);
  }
}
