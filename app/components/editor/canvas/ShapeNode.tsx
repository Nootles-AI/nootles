"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { AI } from "@/app/lib/ai/aiConfig";
import { useCanvasAi } from "./canvasAi";
import type { ShapeNode as ShapeNodeType } from "./types";

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];
const MIN_PREFIX = 2;

export const ShapeNode = memo(function ShapeNode({
  id,
  data,
  selected,
}: NodeProps<ShapeNodeType>) {
  const { updateNodeData, getNodes } = useReactFlow();
  const ai = useCanvasAi();
  // A freshly-added shape (autoEdit) opens straight into editing.
  const [editing, setEditing] = useState(Boolean(data.autoEdit));
  const labelRef = useRef<HTMLDivElement>(null);

  // Ghost completion inside the label. Managed imperatively rather than through
  // React: the label is a contentEditable the browser mutates directly, and
  // rendering into it from React fights those mutations.
  const ghostRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** The label's real text, excluding the ghost span (an element, not a text node). */
  const readLabel = useCallback(() => {
    const el = labelRef.current;
    if (!el) return "";
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
    });
    return out;
  }, []);

  const clearGhost = useCallback(() => {
    ghostRef.current?.remove();
    ghostRef.current = null;
  }, []);

  const showGhost = useCallback(
    (text: string) => {
      const el = labelRef.current;
      if (!el || !text) return;
      clearGhost();
      const span = document.createElement("span");
      span.className = "ab-shape-ghost";
      span.contentEditable = "false";
      span.textContent = text;
      el.appendChild(span);
      ghostRef.current = span;
    },
    [clearGhost],
  );

  const acceptGhost = useCallback(() => {
    const el = labelRef.current;
    const ghost = ghostRef.current;
    if (!el || !ghost) return false;
    const text = ghost.textContent ?? "";
    clearGhost();
    el.appendChild(document.createTextNode(text));
    el.normalize();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return true;
  }, [clearGhost]);

  const complete = useCallback(async () => {
    const prefix = readLabel();
    if (prefix.trim().length < MIN_PREFIX) return;
    // Context: the page text above the diagram, plus the other shapes in it.
    const siblings = getNodes()
      .filter((n) => n.id !== id)
      .map((n) => String((n.data as { label?: unknown })?.label ?? "").trim())
      .filter(Boolean);
    const before = [
      ai?.getDocContext() ?? "",
      siblings.length ? `Diagram nodes: ${siblings.join(", ")}` : "",
      `Node label: ${prefix}`,
    ]
      .filter(Boolean)
      .join("\n");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ before, after: "" }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += value;
      }
      // Labels are short and single-line; ignore anything past the first line.
      const line = acc.split("\n")[0]?.trimEnd() ?? "";
      // Bail if the user kept typing while we were waiting.
      if (readLabel() !== prefix) return;
      if (line.trim()) showGhost(line);
    } catch {
      // aborted or offline — no ghost
    }
  }, [ai, getNodes, id, readLabel, showGhost]);

  const schedule = useCallback(() => {
    clearGhost();
    abortRef.current?.abort();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void complete(), AI.timing.ghostDebounceMs);
  }, [clearGhost, complete]);

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    clearGhost();
  }, [clearGhost]);

  // Focus + select-all when entering edit mode; tear down completion on exit.
  useEffect(() => {
    if (!editing) {
      stop();
      return;
    }
    const el = labelRef.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return stop;
  }, [editing, stop]);

  const commit = () => {
    // Read before removing the ghost is fine (readLabel skips it), but clear it
    // so it can never be persisted as label text.
    const label = readLabel();
    stop();
    setEditing(false);
    updateNodeData(id, { label });
  };

  return (
    <div
      className={`ab-shape ab-shape-${data.shape} ${selected ? "is-selected" : ""} ${
        editing ? "is-editing" : ""
      }`}
    >
      {SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={side}
          className="ab-shape-handle"
        />
      ))}
      {data.shape === "diamond" ? (
        <svg
          className="ab-shape-bg ab-shape-diamond-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="ab-shape-bg" />
      )}
      <div
        ref={labelRef}
        className="ab-shape-label nodrag nopan"
        contentEditable={editing}
        suppressContentEditableWarning
        onDoubleClick={() => setEditing(true)}
        onBlur={commit}
        onInput={schedule}
        onKeyDown={(e) => {
          if (e.key === "Tab" && ghostRef.current) {
            // Accept the completion instead of letting Tab leave the shape.
            e.preventDefault();
            e.stopPropagation();
            acceptGhost();
            return;
          }
          if (e.key === "Escape" && ghostRef.current) {
            e.preventDefault();
            e.stopPropagation();
            clearGhost();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            labelRef.current?.blur();
          }
          if (e.key === "Escape") labelRef.current?.blur();
        }}
      >
        {data.label}
      </div>
    </div>
  );
});
