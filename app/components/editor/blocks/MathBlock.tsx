"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { ComputeEngine } from "@cortex-js/compute-engine";
import { MathField } from "../math/MathField";
import { Katex } from "../math/katex";
import { useReadOnly } from "../readOnly";
import { evaluateLines, type LineResult } from "../math/engine";
import { decodeResults, encodeResults } from "../math/results";
import { useDebouncedPersist } from "../useDebouncedPersist";
import { toDocHtmlSplit } from "@/app/lib/ai/html/serialize";
import { AI } from "@/app/lib/ai/aiConfig";
import { track } from "@/app/lib/telemetry";
import { usePageTitle } from "../PageTitleContext";
import type { AnyBlock } from "@/app/lib/ai/projection";

type Row = { id: number; latex: string };

/** A completion showing under the caret: the rest of this row, plus new rows. */
type MathGhost = { rowId: number; tail: string; rows: string[] };

/** Quiet time before typed rows reach the block. Keystrokes are not writes. */
const PERSIST_MS = 400;

/**
 * As many rows ahead as a suggestion is worth reading. Also where the stream
 * stops: past this the model is writing the rest of the page, on our money.
 */
const GHOST_ROWS = 6;

/**
 * Reads a completion back out of the grammar. The model finishes the open
 * `<nt-math-line>` and may open more, so the text before the first closing tag
 * completes the current row and each closed line after it is a new row.
 *
 * A line whose closing tag hasn't streamed in yet is dropped — half an equation
 * is worse than none.
 */
function parseMathCompletion(acc: string): Omit<MathGhost, "rowId"> | null {
  const end = acc.indexOf("</nt-math-block");
  const parts = (end === -1 ? acc : acc.slice(0, end)).split("</nt-math-line>");
  const tail = parts[0].trim();
  const rows = parts
    .slice(1, -1)
    .map((s) => (s.match(/<nt-math-line[^>]*>([\s\S]*)/)?.[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, GHOST_ROWS);
  if (!tail && !rows.length) return null;
  return { tail, rows };
}

function GhostLatex({ latex }: { latex: string }) {
  return <Katex latex={latex} className="nt-mathblock-ghost" />;
}

function sourceToRows(source: string): Row[] {
  const lines = source.length ? source.split("\n") : [""];
  return lines.map((latex, i) => ({ id: i + 1, latex }));
}

function ResultView({ result }: { result?: LineResult }) {
  if (!result || result.empty) return null;
  if (result.error) {
    return <span className="nt-mathblock-error">{result.error}</span>;
  }
  if (result.valueLatex == null) return null;
  return (
    <Katex latex={`=\\; ${result.valueLatex}`} className="nt-mathblock-value" />
  );
}

type MathBlockProps = {
  source: string;
  /** The evaluated column as stored — see `results.ts`. */
  results: string;
  onChange: (source: string, results: string) => void;
  /** Document HTML split at the caret inside this block, for completion. */
  getFimContext?: (
    offset: number,
    title: string,
  ) => { prefix: string; suffix: string } | null;
};

function MathBlockView({ source, onChange, getFimContext }: MathBlockProps) {
  // A page-level fact, reached from deep in the editor tree.
  const pageTitle = usePageTitle();
  const [rows, setRows] = useState<Row[]>(() => sourceToRows(source));
  const [results, setResults] = useState<LineResult[]>([]);
  const [ghost, setGhost] = useState<MathGhost | null>(null);
  const [focusId, setFocusId] = useState<number | null>(
    source === "" ? 1 : null,
  );

  const nextId = useRef(rows.length + 1);
  const evalTracked = useRef(false);
  const ceClass = useRef<typeof ComputeEngine | null>(null);
  const recomputeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The evaluated column and the rows it was computed from, kept together so a
   * write can only ever store values that belong to the source beside them —
   * the reader trusts the pair and skips the engine entirely.
   */
  const evaluated = useRef<{ source: string; results: LineResult[] }>({
    source: "",
    results: [],
  });
  const persist = useDebouncedPersist(
    (s) =>
      onChange(
        s,
        encodeResults(evaluated.current.source, evaluated.current.results),
      ),
    PERSIST_MS,
    source,
    // An outside change (an AI op, another synced tab): the rows are replaced,
    // and the values follow on the next compute.
    (s) => {
      const rs = sourceToRows(s);
      setRows(rs);
      scheduleRecompute(rs);
    },
  );

  const recompute = (rs: Row[]) => {
    if (!ceClass.current) return;
    const latex = rs.map((r) => r.latex);
    try {
      const next = evaluateLines(ceClass.current, latex);
      evaluated.current = { source: latex.join("\n"), results: next };
      setResults(next);
      if (!evalTracked.current && rs.some((r) => r.latex.trim())) {
        evalTracked.current = true;
        track("math_evaluated", {});
      }
    } catch {
      evaluated.current = { source: "", results: [] };
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleRecompute = (rs: Row[]) => {
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    recomputeTimer.current = setTimeout(() => recompute(rs), 120);
  };
  const schedulePersist = (rs: Row[]) => {
    persist.schedule(rs.map((r) => r.latex).join("\n"));
  };

  // Completion inside the block. The caret is inside a MathLive field rather
  // than the document, so we place it in the serialized HTML by offset — the
  // model still reads the page and answers in <nt-math-line>s.
  const ctxRef = useRef(getFimContext);
  const ghostRef = useRef<MathGhost | null>(null);
  const completeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  useEffect(() => {
    ctxRef.current = getFimContext;
    ghostRef.current = ghost;
  });
  useEffect(
    () => () => {
      if (completeTimer.current) clearTimeout(completeTimer.current);
      abortRef.current?.abort();
    },
    [],
  );

  const runComplete = async (rs: Row[], rowId: number, mySeq: number) => {
    const build = ctxRef.current;
    const idx = rs.findIndex((r) => r.id === rowId);
    if (!build || idx === -1) return;
    // Offset of the row's end within `source` — the rows joined by newlines.
    const offset =
      rs.slice(0, idx).reduce((n, r) => n + r.latex.length + 1, 0) +
      rs[idx].latex.length;
    const ctx = build(offset, pageTitle);
    if (!ctx) return;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // The wire call cuts to these numbers anyway; cutting here too keeps
          // a page carrying one very large block from uploading what is about
          // to be trimmed off again.
          before: ctx.prefix.slice(-AI.fim.maxBefore),
          after: ctx.suffix.slice(0, AI.fim.maxAfter),
          mode: "structure",
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (seqRef.current !== mySeq) return;
        acc += value;
        const parsed = parseMathCompletion(acc);
        if (parsed) setGhost({ rowId, ...parsed });
        // The block is closed, or the suggestion is already further ahead than
        // anyone reads: whatever comes next cannot reach the ghost, and every
        // token of it is paid for.
        if (
          acc.indexOf("</nt-math-block") !== -1 ||
          (parsed?.rows.length ?? 0) >= GHOST_ROWS
        ) {
          break;
        }
      }
      controller.abort();
    } catch {
      // superseded or offline
    }
  };

  /** Stop suggesting: nothing in flight, nothing pending, nothing showing. */
  const dismissGhost = () => {
    seqRef.current++;
    abortRef.current?.abort();
    if (completeTimer.current) clearTimeout(completeTimer.current);
    setGhost(null);
  };

  const scheduleComplete = (rs: Row[], rowId: number) => {
    dismissGhost();
    const mySeq = seqRef.current;
    completeTimer.current = setTimeout(
      () => void runComplete(rs, rowId, mySeq),
      450,
    );
  };

  /** Tab: fold the showing completion into the rows. */
  const acceptGhost = (): boolean => {
    const g = ghostRef.current;
    if (!g) return false;
    dismissGhost();
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === g.rowId);
      if (idx === -1) return prev;
      const added = g.rows.map((latex) => ({ id: nextId.current++, latex }));
      const next = [
        ...prev.slice(0, idx),
        { ...prev[idx], latex: prev[idx].latex + g.tail },
        ...added,
        ...prev.slice(idx + 1),
      ];
      if (added.length) setFocusId(added[added.length - 1].id);
      scheduleRecompute(next);
      schedulePersist(next);
      return next;
    });
    return true;
  };

  const updateRow = (id: number, latex: string) => {
    setRows((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, latex } : r));
      scheduleRecompute(next);
      schedulePersist(next);
      scheduleComplete(next, id);
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
    <div className="nt-mathblock" contentEditable={false}>
      {rows.map((row, i) => (
        <Fragment key={row.id}>
          <div className="nt-mathblock-row">
            <div className="nt-mathblock-input">
              <MathField
                value={row.latex}
                autoFocus={row.id === focusId}
                onChange={(l) => updateRow(row.id, l)}
                onEnter={() => addRowAfter(row.id)}
                onBackspaceEmpty={() => removeRow(row.id)}
                onTab={acceptGhost}
                onEscape={dismissGhost}
              />
              {ghost?.rowId === row.id && ghost.tail ? (
                <GhostLatex latex={ghost.tail} />
              ) : null}
            </div>
            <ResultView result={results[i]} />
          </div>
          {ghost?.rowId === row.id
            ? ghost.rows.map((latex, j) => (
                <div className="nt-mathblock-row" key={`ghost-${j}`}>
                  <div className="nt-mathblock-input">
                    <GhostLatex latex={latex} />
                  </div>
                </div>
              ))
            : null}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The share viewer's math block: the same rows and the same evaluated results,
 * drawn with KaTeX instead of mounting a MathLive field per line.
 *
 * The results are content, so they ride with the source and are simply read
 * back. The engine loads only when they are missing or belong to a source that
 * has since changed — a board written by the AI, or a document last edited
 * before the values were stored.
 */
function MathBlockStatic({
  source,
  results: stored,
}: {
  source: string;
  results: string;
}) {
  const rows = sourceToRows(source);
  const saved = useMemo(() => decodeResults(source, stored), [source, stored]);
  const [computed, setComputed] = useState<LineResult[] | null>(null);

  useEffect(() => {
    if (saved) return;
    let cancelled = false;
    void import("@cortex-js/compute-engine").then(({ ComputeEngine }) => {
      if (cancelled) return;
      try {
        setComputed(evaluateLines(ComputeEngine, source.split("\n")));
      } catch {
        setComputed(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [source, saved]);

  const results = saved ?? computed;

  return (
    <div className="nt-mathblock" contentEditable={false}>
      {rows.map((row, i) => (
        <div className="nt-mathblock-row" key={row.id}>
          <div className="nt-mathblock-input">
            {row.latex.trim() && <Katex latex={row.latex} />}
          </div>
          <ResultView result={results?.[i]} />
        </div>
      ))}
    </div>
  );
}

/** Hooks live in the branches, so the choice has to sit one component above. */
function MathBlockRoot(props: MathBlockProps) {
  const readOnly = useReadOnly();
  if (readOnly) {
    return <MathBlockStatic source={props.source} results={props.results} />;
  }
  return <MathBlockView {...props} />;
}

export const mathBlockSpec = createReactBlockSpec(
  {
    type: "mathBlock",
    propSchema: { source: { default: "" }, results: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <MathBlockRoot
        source={block.props.source}
        results={block.props.results}
        onChange={(source, results) =>
          editor.updateBlock(block.id, { props: { source, results } })
        }
        getFimContext={(offset, title) =>
          toDocHtmlSplit(
            editor.document as unknown as AnyBlock[],
            block.id,
            offset,
            { title, window: AI.projection.window, collapseDrawn: true },
          )
        }
      />
    ),
  },
)();
