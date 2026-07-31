"use client";

import type { ReactNode } from "react";
import "./controls.css";

/** A labelled row inside a section. The label column is fixed so every control
 *  in the panel starts on the same vertical line. */
export function Field({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="ab-field">
      {label !== undefined && <span className="ab-field-label">{label}</span>}
      <div className="ab-field-body">{children}</div>
    </div>
  );
}
