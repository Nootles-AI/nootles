import type { StyleMap } from "./types";

/**
 * `var(--x)` — reading it, resolving it, and reading which properties declare
 * one.
 *
 * This is the pure half of what used to live entirely in
 * `panels/colorVariables.ts`: no React, no context, nothing that only makes
 * sense inside the style panel. It moved here (COMPILE, build-plan Conflict 1 /
 * OQ-1) because `app/lib/ai/html/toHtml.ts` needs exactly this reading —
 * `resolveVars`'s `{ resolveVars: true }` option inlines every custom property
 * the same way a swatch would show it — and a pure module cannot import a
 * `"use client"` React file to get it. `panels/colorVariables.ts` re-exports
 * `resolveVars` and `ColorVariable` so its own callers (the style panel,
 * `ColorField`, `GradientField`) see no difference; everything that touches
 * `ColorVariablesContext` stays in the panel, because it has no meaning
 * outside a React tree.
 *
 * `refName` joined it here (TOOLS, build-plan Conflict 1 / OQ-1): `get_styles`
 * (`app/lib/ai/canvas/styles.ts`) needs to say whether a shape's colour is a
 * bare `var(--x)` reference or a literal value, which is exactly what
 * `refName` answers, and that reporter is as pure as `resolveVars` — no
 * React, no context. `panels/colorVariables.ts` re-exports it unchanged, so
 * its own callers see no difference.
 */

/** `name` includes its leading `--`, exactly as the declaration spells it. */
export type ColorVariable = { name: string; value: string };

/** One `var(--x)` or `var(--x, fallback)` found inside a CSS value, located by
 *  character offset so a caller can walk a string full of them. */
export type VarRef = { start: number; end: number; name: string; fallback?: string };

/** Every `var(--x)` and `var(--x, fallback)` in an arbitrary CSS value replaced
 *  by the colour it stands for, so a swatch — or the compiler's `resolveVars`
 *  option — can paint it outright. An unresolvable reference is left alone. */
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

/** The next `var(...)` at or after `from`, scanned rather than matched so that
 *  a nested fallback closes on the right bracket. */
export function findVar(css: string, from: number): VarRef | null {
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

/**
 * Every custom property a style declares, in authored order — the compiler's
 * root-level `--*` block (`toHtml.ts` §3.12). Deliberately not colour-filtered:
 * unlike `panels/colorVariables.ts`'s `readColorVariables`, which exists to
 * build a swatch list and drops anything that does not parse as a colour, the
 * compiled output has to carry every declared custom property whether or not
 * it looks like a colour — `--gap: 16px` is still something a `var(--gap)`
 * elsewhere in the document depends on.
 */
export function customProperties(style: StyleMap): ColorVariable[] {
  return Object.keys(style)
    .filter((name) => name.startsWith("--"))
    .map((name) => ({ name, value: style[name] }));
}

/** The whole value is one reference — the only shape a plain colour field
 *  ever writes, and what `get_styles` calls a shape's colour "a token" rather
 *  than a value that merely contains one. */
export function refName(css: string): string | null {
  const s = css.trim();
  const ref = findVar(s, 0);
  return ref && ref.start === 0 && ref.end === s.length ? ref.name : null;
}
