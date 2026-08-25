"use client";

import { useEffect, useState } from "react";

/**
 * KaTeX, loaded on demand.
 *
 * The same bargain {@link MathField} makes with MathLive, for the same reason:
 * the maths blocks are registered in the editor's schema, so anything they
 * import statically is downloaded by every page whether or not it has an
 * equation on it. The renderer is cached at module scope after the first load,
 * so every equation after the first sets on its first paint.
 */
export type RenderLatex = (latex: string) => string;

let cached: RenderLatex | null = null;
let loading: Promise<RenderLatex> | null = null;

function load(): Promise<RenderLatex> {
  loading ??= import("./katexBundle").then((m) => (cached = m.renderLatex));
  return loading;
}

/** The renderer if it is here, and a re-render when it arrives if it is not. */
export function useKatex(): RenderLatex | null {
  const [render, setRender] = useState<RenderLatex | null>(() => cached);
  useEffect(() => {
    if (render) return;
    let cancelled = false;
    void load().then((r) => {
      if (!cancelled) setRender(() => r);
    });
    return () => {
      cancelled = true;
    };
  }, [render]);
  return render;
}

/**
 * The renderer for callers that draw into the DOM themselves rather than
 * render — the AI preview widgets, which build their elements by hand.
 */
export function loadKatex(): RenderLatex | Promise<RenderLatex> {
  return cached ?? load();
}

/**
 * Typeset LaTeX. Nothing at all until the renderer is here: the values in a
 * maths block already arrive a beat late, and blank for that beat is quieter
 * than a flash of source.
 */
export function Katex({
  latex,
  className,
}: {
  latex: string;
  className?: string;
}) {
  const render = useKatex();
  if (!render) return null;
  return (
    <span className={className} dangerouslySetInnerHTML={{ __html: render(latex) }} />
  );
}
