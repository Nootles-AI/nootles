"use client";

import type { ReactNode } from "react";
import { Tooltip } from "@/app/components/Tooltip";
import "./controls.css";

/**
 * The action at the end of a row — hide this fill, remove that effect.
 *
 * Fill, stroke and effects each had their own, and they disagreed: one section
 * ended up with a 32px eye beside a 24px close in the same row, and two used a
 * native `title` where the rest of the panel uses the app's tooltip.
 */
export function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        className="nt-icon-btn is-sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}
