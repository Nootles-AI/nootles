"use client";

import { Menu, MenuItem } from "@/app/components/Menu";
import { Check, ChevronsUpDown } from "@/app/components/Icons";
import "./controls.css";

export type SelectOption = { value: string; label: string };

export function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
}) {
  const current = options.find((o) => o.value === value);

  return (
    <Menu
      label="Options"
      side="bottom"
      trigger={(p) => (
        <button {...p} className="ab-ctl-select">
          <span className="ab-ctl-select-value">{current?.label ?? value}</span>
          <ChevronsUpDown width={12} height={12} className="ab-ctl-select-caret" />
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
            <span className="ab-ctl-check">
              {o.value === value && <Check width={12} height={12} />}
            </span>
            {o.label}
          </MenuItem>
        ))
      }
    </Menu>
  );
}
