/**
 * The icon registry — the runtime face of the curated catalog.
 *
 * An `<nt-icon name="cat">` in model output is a DIALECT, not a node kind: the
 * parser resolves the name here and the document receives an ordinary
 * `<nt-path>` with the icon's real geometry scaled into its box — as editable
 * as anything the pen drew, which is the point. No document ever stores an
 * icon reference, so documents stay self-contained and the catalog can grow
 * or change without a migration.
 *
 * The catalog itself (~150KB of path data) stays out of every bundle until an
 * AI lane actually asks for one: `loadIconCatalog()` is a dynamic import the
 * lanes kick off when they dispatch a request and AWAIT before parsing model
 * output, so lookup itself can stay synchronous — which is what keeps
 * `parseScene` pure and every existing call site untouched. Editing sessions
 * that never produce a diagram never pay for it.
 */

export type IconDef = {
  /** Source box the path data is drawn in. */
  w: number;
  h: number;
  /** How the glyph is painted: a silhouette's fill, or a line icon's stroke. */
  mode: "fill" | "stroke";
  /** Bare SVG path data — every primitive already converted at build time. */
  d: string;
};

let catalog: Record<string, IconDef> | null = null;
let loading: Promise<void> | null = null;

export function loadIconCatalog(): Promise<void> {
  loading ??= import("./catalog").then((m) => {
    catalog = m.ICON_CATALOG;
  });
  return loading;
}

/** Synchronous lookup against whatever has loaded. Null before the load too —
 * callers on the AI paths have awaited {@link loadIconCatalog} first. */
export function iconFor(name: string): IconDef | null {
  return catalog?.[name.trim().toLowerCase()] ?? null;
}
