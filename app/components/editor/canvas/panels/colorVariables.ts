"use client";

/**
 * Colour variables are CSS custom properties on `<nt-diagram>`'s own style —
 * `--brand: #6366f1` — referenced by shapes as `var(--brand)`. There is no
 * registry: the grammar already stores both halves, so a variable round-trips
 * for free and an AI edit reads the same way a human one does.
 *
 * The panel is not rendered inside the diagram, so nothing here can lean on the
 * cascade to resolve a reference — {@link resolveVars} is what a swatch shows.
 */

import { createContext, useContext } from "react";
import type { StyleMap, StylePatch } from "../scene/types";
import { findVar, resolveVars, type ColorVariable } from "../scene/vars";
import { parseColor } from "./controls/color";

/**
 * `resolveVars` and `ColorVariable` moved to `scene/vars.ts` (COMPILE,
 * build-plan Conflict 1 / OQ-1) — the pure half of this file, and the half
 * `app/lib/ai/html/toHtml.ts` needs without pulling in a `"use client"`
 * React module. Re-exported here so this panel's own callers (`ColorField`,
 * `GradientField`, `StylePanel`) see no difference.
 */
export { resolveVars };
export type { ColorVariable };

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
