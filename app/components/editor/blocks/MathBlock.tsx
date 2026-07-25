"use client";

import { useEffect, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { createReactBlockSpec } from "@blocknote/react";
import type { ComputeEngine } from "@cortex-js/compute-engine";
import { MathField } from "../math/MathField";
import { evaluateLines, type LineResult } from "../math/engine";

type Row = { id: number; latex: string };

function sourceToRows(source: string): Row[] {
  const lines = source.length ? source.split("\n") : [""];
  return lines.map((latex, i) => ({ id: i + 1, latex }));
}

function ResultView({ result }: { result?: LineResult }) {
  if (!result || result.empty) return null;
  if (result.error) {
    return <span className="ab-mathblock-error">{result.error}</span>;
  }
  if (result.valueLatex == null) return null;
  const html = katex.renderToString(`=\\; ${result.valueLatex}`, {
    throwOnError: false,
  });
  return (
    <span
      className="ab-mathblock-value"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function MathBlockView({
  source,
  onChange,
}: {
  source: string;
  onChange: (source: string) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => sourceToRows(source));
  const [results, setResults] = useState<LineResult[]>([]);
  const [focusId, setFocusId] = useState<number | null>(
    source === "" ? 1 : null,
  );

  const nextId = useRef(rows.length + 1);
  const ceClass = useRef<typeof ComputeEngine | null>(null);
  const recomputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last value we persisted; lets us tell our own round-tripped writes apart
  // from genuinely external `source` changes (AI ops, another synced tab).
  const lastSource = useRef(source);

  const recompute = (rs: Row[]) => {
    if (!ceClass.current) return;
    try {
      setResults(evaluateLines(ceClass.current, rs.map((r) => r.latex)));
    } catch {
      setResults([]);
    }
  };

  // Lazy-load the compute engine (heavy, client-only) then do the first compute.
  useEffect(() => {
    let cancelled = false;
    void import("@cortex-js/compute-engine").then(({ ComputeEngine }) => {
      if (cancelled) return;
      ceClass.current = ComputeEngine;
      recompute(rows);
    });
    return () => {
      cancelled = true;
      if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleRecompute = (rs: Row[]) => {
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    recomputeTimer.current = setTimeout(() => recompute(rs), 120);
  };
  const schedulePersist = (rs: Row[]) => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const s = rs.map((r) => r.latex).join("\n");
      lastSource.current = s;
      onChange(s);
    }, 400);
  };

  // Reconcile external `source` changes (an AI op, or the same doc edited in
  // another tab). Our own debounced writes set `lastSource` first, so they
  // no-op here and never stomp the caret mid-edit.
  useEffect(() => {
    if (source === lastSource.current) return;
    lastSource.current = source;
    const rs = sourceToRows(source);
    setRows(rs);
    scheduleRecompute(rs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const updateRow = (id: number, latex: string) => {
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, latex } : r));
      scheduleRecompute(next);
      schedulePersist(next);
      return next;
    });
  };

  const addRowAfter = (id: number) => {
    const newRow = { id: nextId.current++, latex: "" };
    setFocusId(newRow.id);
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      const next = [...prev.slice(0, idx + 1), newRow, ...prev.slice(idx + 1)];
      schedulePersist(next);
      return next;
    });
  };

  const removeRow = (id: number) => {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex((r) => r.id === id);
      const next = prev.filter((r) => r.id !== id);
      setFocusId(next[Math.max(0, idx - 1)]?.id ?? null);
      scheduleRecompute(next);
      schedulePersist(next);
      return next;
    });
  };

  return (
    <div className="ab-mathblock" contentEditable={false}>
      {rows.map((row, i) => (
        <div className="ab-mathblock-row" key={row.id}>
          <div className="ab-mathblock-input">
            <MathField
              initialValue={row.latex}
              autoFocus={row.id === focusId}
              onChange={(l) => updateRow(row.id, l)}
              onEnter={() => addRowAfter(row.id)}
              onBackspaceEmpty={() => removeRow(row.id)}
            />
          </div>
          <ResultView result={results[i]} />
        </div>
      ))}
    </div>
  );
}

export const mathBlockSpec = createReactBlockSpec(
  {
    type: "mathBlock",
    propSchema: { source: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <MathBlockView
        source={block.props.source}
        onChange={(source) =>
          editor.updateBlock(block.id, { props: { source } })
        }
      />
    ),
  },
)();
