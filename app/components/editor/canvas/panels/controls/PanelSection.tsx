"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "@/app/components/Icons";
import { Tooltip } from "@/app/components/Tooltip";
import "./controls.css";

/**
 * One group of properties.
 *
 * The title sits on the same 16px line as the field marks below it, and the
 * actions end on the same 8px right margin as the grid's action gutter. Both
 * used to be off: the chevron pushed the title out to 24px, and the `+` hung
 * flush to the panel edge, 8px past everything it introduced.
 *
 * The disclosure chevron moved to the right for that reason — a leading one
 * cannot indent itself without indenting the title with it.
 */
export function PanelSection({
  title,
  children,
  onAdd,
  addLabel,
}: {
  title: string;
  children: ReactNode;
  /** Renders the `+` affordance. */
  onAdd?: () => void;
  /** What the `+` adds, spelled out. Defaults to the title, lowercased. */
  addLabel?: string;
}) {
  const [open, setOpen] = useState(true);
  const add = addLabel ?? `Add ${title.toLowerCase()}`;

  return (
    <section className="nt-ctl-section">
      <div className="nt-ctl-head">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="nt-ctl-title"
        >
          {title}
        </button>
        {onAdd && (
          <Tooltip label={add}>
            <button onClick={onAdd} aria-label={add} className="nt-icon-btn is-sm">
              <Plus width={14} height={14} />
            </button>
          </Tooltip>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          className="nt-icon-btn is-sm"
        >
          <ChevronRight
            width={12}
            height={12}
            className={`nt-ctl-chevron${open ? " is-open" : ""}`}
          />
        </button>
      </div>
      {open && <div className="nt-ctl-section-body">{children}</div>}
    </section>
  );
}

/**
 * A checkbox on its own line — Figma's "Clip content", the toolbar's snapping.
 * Three near-identical ones were drawn by hand before this.
 */
export function CheckRow({
  label,
  on,
  mixed,
  onChange,
}: {
  label: string;
  on: boolean;
  mixed?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      role="checkbox"
      aria-checked={mixed ? "mixed" : on}
      onClick={() => onChange(!on)}
      className="nt-ctl-check-row"
    >
      <span aria-hidden className={`nt-ctl-box${on && !mixed ? " is-on" : ""}`}>
        {mixed ? <span className="nt-ctl-box-mixed" /> : on ? <Tick /> : null}
      </span>
      {label}
    </button>
  );
}

function Tick() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  );
}
