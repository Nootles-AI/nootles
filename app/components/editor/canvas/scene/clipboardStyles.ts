import type { Scene, StyleMap } from "./types";

/** Carry inherited design dependencies without overwriting the destination board. */
export function clipboardStyles(style: StyleMap): StyleMap {
  const resolve = (value: string, path: Set<string>): string | null => {
    let invalid = false;
    const result = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name: string, fallback: string | undefined) => {
      const next = !path.has(name) && style[name] !== undefined && path.size < 32
        ? resolve(style[name], new Set([...path, name])) : null;
      if (next !== null) return next;
      if (fallback !== undefined) return fallback;
      invalid = true; return "";
    });
    // Complex unresolved fallback syntax remains authored; simple aliases freeze
    // at the declaration scope, as CSS inheritance does before a child overrides a token.
    return invalid ? null : result;
  };
  return Object.fromEntries(Object.entries(style)
    .filter(([key]) => key.startsWith("--") || /^(color|font(-family|-size|-weight|-style|-stretch|-variant.*)?|line-height|letter-spacing|word-spacing|text-align|direction)$/.test(key))
    .map(([key, value]) => [key, resolve(value, new Set([key])) ?? "initial"]));
}

/** Local declarations isolate a pasted fragment from identically named destination tokens. */
export function localizeClipboardStyles(fragment: Scene): Scene {
  const inherited = clipboardStyles(fragment.style);
  if (!Object.keys(inherited).length) return fragment;
  return { ...fragment,
    nodes: fragment.nodes.map((node) => ({ ...node, style: { ...inherited, ...node.style } })),
    edges: fragment.edges.map((edge) => ({ ...edge, style: { ...inherited, ...edge.style } })),
  };
}
