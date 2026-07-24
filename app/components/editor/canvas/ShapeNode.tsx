"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import type { ShapeNode as ShapeNodeType } from "./types";

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

export const ShapeNode = memo(function ShapeNode({
  id,
  data,
  selected,
}: NodeProps<ShapeNodeType>) {
  const { updateNodeData } = useReactFlow();
  // A freshly-added shape (autoEdit) opens straight into editing.
  const [editing, setEditing] = useState(Boolean(data.autoEdit));
  const labelRef = useRef<HTMLDivElement>(null);

  // Focus + select-all when entering edit mode.
  useEffect(() => {
    if (!editing || !labelRef.current) return;
    const el = labelRef.current;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  const commit = () => {
    setEditing(false);
    updateNodeData(id, { label: labelRef.current?.textContent ?? "" });
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
        onKeyDown={(e) => {
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
