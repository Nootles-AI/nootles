"use client";

import { Menu, MenuItem } from "@/app/components/Menu";
import { Check, ChevronsUpDown } from "@/app/components/Icons";
import "./controls.css";

export type SelectOption = { value: string; label: string };

/**
 * A select carries its own name inline, the way the number fields do.
 *
 * "Normal" and "Uppercase" do not say which property they are the value of,
 * and the panel has no label column to say it for them — a fixed one cost 54px
 * of a 223px body and put a second left edge down the middle of every section.
 */
export function SelectField({
  label,
  name,
  value,
  onChange,
  options,
}: {
  /** The mark drawn inside the control. */
  label?: string;
  /** The name spoken for it — spell out what the mark abbreviates. */
  name?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
}) {
  const current = options.find((o) => o.value === value);
  const spoken = name ?? label;

  return (
    <Menu
      label={spoken ?? "Options"}
      side="bottom"
      trigger={(p) => (
        <button {...p} className="nt-ctl-select" aria-label={spoken}>
          {label !== undefined && (
            <span className="nt-ctl-mark" aria-hidden>
              {label}
            </span>
          )}
          <span className="nt-ctl-select-value">{current?.label ?? value}</span>
          <ChevronsUpDown width={12} height={12} className="nt-ctl-select-caret" />
        </button>
      )}
    >
      {(close) =>
        options.map((o) => (
          <MenuItem
            key={o.value}
            onClick={() => {
              onChange(o.value);
              close();
            }}
          >
            <span className="nt-ctl-check">
              {o.value === value && <Check width={12} height={12} />}
            </span>
            {o.label}
          </MenuItem>
        ))
      }
    </Menu>
  );
}
