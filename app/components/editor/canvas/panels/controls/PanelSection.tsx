"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "@/app/components/Icons";
import "./controls.css";

/**
 * One group of properties. Takes the shell's section label — the same mono
 * voice as PAGES in the sidebar — so the style panel reads as part of the app
 * rather than as a second design of the same thing.
 */
export function PanelSection({
  title,
  children,
  onAdd,
}: {
  title: string;
  children: ReactNode;
  /** Renders the `+` affordance; the label is built from the title. */
  onAdd?: () => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="ab-ctl-section">
      <div className="ab-section-label">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ab-ctl-section-toggle"
        >
          <ChevronRight
            width={12}
            height={12}
            className={`ab-ctl-chevron${open ? " is-open" : ""}`}
          />
          <span>{title}</span>
        </button>
        {onAdd && (
          <button
            onClick={onAdd}
            aria-label={`Add ${title.toLowerCase()}`}
            title={`Add ${title.toLowerCase()}`}
            className="ab-icon-btn"
          >
            <Plus width={14} height={14} />
          </button>
        )}
      </div>
      {open && <div className="ab-ctl-section-body">{children}</div>}
    </section>
  );
}
