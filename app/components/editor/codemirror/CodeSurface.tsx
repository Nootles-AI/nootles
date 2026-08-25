"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { CodeMirrorEditor } from "./CodeMirrorEditor";
import { eveningPalette } from "./palette";

/**
 * The code block's editor, loaded on demand.
 *
 * CodeMirror's core is some 700KB — larger than everything else the editor
 * route ships put together — and the block is registered in the schema, so
 * importing it statically means every page pays for it whether or not there is
 * a line of code on it. Only the grammars were lazy; now the editor is too.
 *
 * The class is cached at module scope after the first load, so the second code
 * block on a page mounts synchronously, and the text is drawn as plain code
 * until the first one arrives — the same text, at the same size, in the same
 * place, so what lands is syntax colour rather than a reflow.
 */
type Props = Parameters<typeof CodeMirrorEditor>[0];

let cached: typeof CodeMirrorEditor | null = null;
let loading: Promise<typeof CodeMirrorEditor> | null = null;

function load(): Promise<typeof CodeMirrorEditor> {
  loading ??= import("./CodeMirrorEditor").then(
    (m) => (cached = m.CodeMirrorEditor),
  );
  return loading;
}

/** Matches the theme's `.cm-content`, which replaces this on arrival. */
const PLAIN: CSSProperties = {
  margin: 0,
  padding: "10px 14px",
  fontSize: 13,
  lineHeight: 1.6,
  fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, monospace",
  color: eveningPalette.fg,
  overflowX: "auto",
};

export function CodeSurface(props: Props) {
  const [Editor, setEditor] = useState<typeof CodeMirrorEditor | null>(
    () => cached,
  );

  useEffect(() => {
    if (Editor) return;
    let cancelled = false;
    void load().then((E) => {
      if (!cancelled) setEditor(() => E);
    });
    return () => {
      cancelled = true;
    };
  }, [Editor]);

  if (!Editor) {
    return (
      <pre className="nt-cm" style={PLAIN}>
        {props.initialValue}
      </pre>
    );
  }
  return <Editor {...props} />;
}
