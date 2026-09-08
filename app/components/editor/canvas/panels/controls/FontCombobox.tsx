"use client";

import { useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "../../../../Icons";
import { familyName } from "../../render/fonts";
import { familyValue, FONT_OPTIONS, type FontOption } from "../fontCatalog";
import { Popover } from "./Popover";

/**
 * The family field: a search over the families the catalog names, and any
 * other name typed in full. Figma's font picker, at the panel's width.
 *
 * The value is the declaration itself — `"Inter", sans-serif` — so a chosen
 * family and a typed one land in the document the same way, and the loader
 * (`render/fonts.ts`) asks for whichever it is.
 */
export function FontCombobox({
  value,
  mixed,
  onChange,
}: {
  value: string;
  mixed?: boolean;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const current = FONT_OPTIONS.find((o) => o.value === value);
  const shown = mixed ? "Mixed" : (current?.label ?? familyName(value) ?? value ?? "Default");

  const matches = useMemo<FontOption[]>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return FONT_OPTIONS;
    return FONT_OPTIONS.filter((o) => o.label.toLowerCase().includes(needle));
  }, [query]);

  const typed = query.trim();
  const exact = matches.some((o) => o.label.toLowerCase() === typed.toLowerCase());

  return (
    <Popover
      width={223}
      label="Font"
      trigger={(p) => (
        <button {...p} className="nt-ctl-select" aria-label="Font">
          <span className="nt-ctl-mark" aria-hidden>
            Font
          </span>
          <span className="nt-ctl-select-value">{shown}</span>
          <ChevronsUpDown width={12} height={12} className="nt-ctl-select-caret" />
        </button>
      )}
    >
      {(close) => (
        <div className="nt-font-pop">
          <input
            ref={input}
            autoFocus
            className="nt-input"
            value={query}
            placeholder="Search fonts"
            aria-label="Search fonts"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const pick = matches[0];
              if (pick && (exact || !typed)) {
                onChange(pick.value);
              } else if (typed) {
                onChange(familyValue(typed));
              }
              setQuery("");
              close();
            }}
          />
          <div className="nt-font-list" role="listbox" aria-label="Fonts">
            {matches.map((o) => (
              <button
                key={o.value || "default"}
                role="option"
                aria-selected={o.value === value}
                className="nt-menu-item nt-font-option"
                style={o.value ? { fontFamily: o.value } : undefined}
                onClick={() => {
                  onChange(o.value);
                  setQuery("");
                  close();
                }}
              >
                <span className="nt-ctl-check">
                  {o.value === value && <Check width={12} height={12} />}
                </span>
                {o.label}
              </button>
            ))}
            {typed && !exact && (
              // Any name at all: the loader will ask for it, and a face the
              // machine has renders whether or not Google has heard of it.
              <button
                role="option"
                aria-selected={false}
                className="nt-menu-item nt-font-option"
                onClick={() => {
                  onChange(familyValue(typed));
                  setQuery("");
                  close();
                }}
              >
                <span className="nt-ctl-check" />
                Use “{typed}”
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
