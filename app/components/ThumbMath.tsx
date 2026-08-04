"use client";

import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * Maths inside a page picture, set by KaTeX.
 *
 * Its own module so KaTeX and its stylesheet are loaded only by a page that
 * actually has maths on it — the same bargain `ThumbDiagram` makes with the
 * canvas renderer. Most pages have neither.
 *
 * Worth the weight: raw LaTeX is not a smaller version of an equation, it is a
 * different thing on the page. `\frac{a+d}{2}` reads as a formula once it is
 * set and as a syntax error until it is, and a preview whose job is to say
 * "this is what a Nootles page looks like" cannot afford the second reading.
 */
export default function ThumbMath({
  latex,
  display,
}: {
  latex: string;
  display?: boolean;
}) {
  // `throwOnError: false` renders a malformed expression as red text rather
  // than taking the preview down with it — the same bargain the editor makes.
  const html = katex.renderToString(latex, {
    throwOnError: false,
    displayMode: display,
  });
  return (
    <span
      className={display ? "nt-thumb-katex is-block" : "nt-thumb-katex"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
