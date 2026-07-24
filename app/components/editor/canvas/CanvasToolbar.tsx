"use client";

import { ReactNode } from "react";
import type { ShapeKind } from "./types";

const svg = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const icons: Record<string, ReactNode> = {
  rectangle: (
    <svg {...svg}>
      <rect x="3.5" y="6" width="17" height="12" rx="2" />
    </svg>
  ),
  ellipse: (
    <svg {...svg}>
      <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
    </svg>
  ),
  diamond: (
    <svg {...svg}>
      <path d="M12 3 21 12 12 21 3 12z" />
    </svg>
  ),
  text: (
    <svg {...svg}>
      <path d="M5 6h14M12 6v12M9 18h6" />
    </svg>
  ),
  layout: (
    <svg {...svg}>
      <rect x="9" y="3" width="6" height="5" rx="1" />
      <rect x="3" y="15" width="6" height="5" rx="1" />
      <rect x="15" y="15" width="6" height="5" rx="1" />
      <path d="M12 8v3M12 11H6v4M12 11h6v4" />
    </svg>
  ),
  fit: (
    <svg {...svg}>
      <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
    </svg>
  ),
  trash: (
    <svg {...svg}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
    </svg>
  ),
};

function ToolButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="ab-canvas-tool"
      title={title}
      aria-label={title}
      disabled={disabled}
      // Keep pointer events out of React Flow's pan/zoom.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function CanvasToolbar({
  onAddShape,
  onLayout,
  onFit,
  onDelete,
  hasSelection,
}: {
  onAddShape: (kind: ShapeKind) => void;
  onLayout: () => void;
  onFit: () => void;
  onDelete: () => void;
  hasSelection: boolean;
}) {
  return (
    <div className="ab-canvas-toolbar nodrag nopan">
      <ToolButton title="Rectangle" onClick={() => onAddShape("rectangle")}>
        {icons.rectangle}
      </ToolButton>
      <ToolButton title="Ellipse" onClick={() => onAddShape("ellipse")}>
        {icons.ellipse}
      </ToolButton>
      <ToolButton title="Diamond" onClick={() => onAddShape("diamond")}>
        {icons.diamond}
      </ToolButton>
      <ToolButton title="Text" onClick={() => onAddShape("text")}>
        {icons.text}
      </ToolButton>
      <span className="ab-canvas-tool-sep" />
      <ToolButton title="Auto-layout" onClick={onLayout}>
        {icons.layout}
      </ToolButton>
      <ToolButton title="Fit to view" onClick={onFit}>
        {icons.fit}
      </ToolButton>
      <span className="ab-canvas-tool-sep" />
      <ToolButton title="Delete selected" onClick={onDelete} disabled={!hasSelection}>
        {icons.trash}
      </ToolButton>
    </div>
  );
}
