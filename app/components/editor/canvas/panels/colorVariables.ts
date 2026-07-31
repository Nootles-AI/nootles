"use client";

/**
 * Colour variables are CSS custom properties on `<ab-diagram>`'s own style —
 * `--brand: #6366f1` — referenced by shapes as `var(--brand)`. There is no
 * registry: the grammar already stores both halves, so a variable round-trips
 * for free and an AI edit reads the same way a human one does.
 *
 * The panel is not rendered inside the diagram, so nothing here can lean on the
 * cascade to resolve a reference — {@link resolveVars} is what a swatch shows.
 */

import { createContext, useContext } from "react";
import type { StyleMap, StylePatch } from "../scene/types";
import { parseColor } from "./controls/color";

/** `name` includes its leading `--`, exactly as the declaration spells it. */
export type ColorVariable = { name: string; value: string };

export type ColorVariablesApi = {
  /** Declared on the diagram, in authored order. */
  variables: readonly ColorVariable[];
  /** Merge declarations into the diagram's own style. */
  setStyle: (decls: StylePatch) => void;
};

export const ColorVariablesContext = createContext<ColorVariablesApi | null>(null);

/** `null` wherever the diagram's style is out of reach — every caller degrades
 *  to a plain colour field. */
export function useColorVariables(): ColorVariablesApi | null {
  return useContext(ColorVariablesContext);
}

/** The custom properties that hold a colour. A `--gap` is not a swatch. */
export function readColorVariables(style: StyleMap | undefined): ColorVariable[] {
  if (!style) return [];
  const all = Object.keys(style)
    .filter((name) => name.startsWith("--"))
    .map((name) => ({ name, value: style[name] }));
  return all.filter((v) => parseColor(resolveVars(v.value, all)) !== null);
}

export const varRef = (name: string) => `var(${name})`;

/** What the sidebar shows in place of a hex code. */
export const varLabel = (name: string) => name.replace(/^--/, "");

/** The whole value is one reference — the only shape the panel ever writes. */
export function refName(css: string): string | null {
  const s = css.trim();
  const ref = findVar(s, 0);
  return ref && ref.start === 0 && ref.end === s.length ? ref.name : null;
}

/** Every `var(--x)` and `var(--x, fallback)` in an arbitrary CSS value replaced
 *  by the colour it stands for, so a swatch can paint it. An unresolvable
 *  reference is left alone. */
export function resolveVars(
  css: string,
  vars: readonly ColorVariable[],
  depth = 0,
): string {
  if (depth > 8 || !css.includes("var(")) return css;
  let out = "";
  let i = 0;
  for (;;) {
    const ref = findVar(css, i);
    if (!ref) return out + css.slice(i);
    const raw = vars.find((v) => v.name === ref.name)?.value ?? ref.fallback;
    out +=
      css.slice(i, ref.start) +
      (raw === undefined
        ? css.slice(ref.start, ref.end)
        : resolveVars(raw, vars, depth + 1));
    i = ref.end;
  }
}

export const declareVariable = (name: string, value: string): StylePatch => ({
  [name]: value,
});

export const removeVariable = (name: string): StylePatch => ({ [name]: undefined });

/** References elsewhere in the document are the caller's problem — this only
 *  moves the declaration. */
export const renameVariable = (
  from: string,
  to: string,
  value: string,
): StylePatch => ({ [from]: undefined, [to]: value });

/** Free-text → a legal custom property name, or `null` if nothing is left. */
export function toVariableName(text: string): string | null {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return slug ? `--${slug}` : null;
}

export function nextVariableName(vars: readonly ColorVariable[]): string {
  for (let i = 1; ; i++) {
    const name = `--color-${i}`;
    if (!vars.some((v) => v.name === name)) return name;
  }
}

type VarRef = { start: number; end: number; name: string; fallback?: string };

/** The next `var(...)` at or after `from`, scanned rather than matched so that
 *  a nested fallback closes on the right bracket. */
function findVar(css: string, from: number): VarRef | null {
  for (let i = css.indexOf("var(", from); i >= 0; i = css.indexOf("var(", i + 4)) {
    let depth = 0;
    let j = i + 3;
    for (; j < css.length; j++) {
      if (css[j] === "(") depth++;
      else if (css[j] === ")" && --depth === 0) break;
    }
    if (depth !== 0) return null;
    const inner = css.slice(i + 4, j);
    const comma = inner.indexOf(",");
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    if (name.startsWith("--")) {
      return {
        start: i,
        end: j + 1,
        name,
        fallback: comma < 0 ? undefined : inner.slice(comma + 1).trim() || undefined,
      };
    }
  }
  return null;
}
