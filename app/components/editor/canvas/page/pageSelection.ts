import type { SelectionStore } from "../engine/useSelection";
import { nodeBounds, type RotatedRect } from "../scene/geometry";
import type { EdgeId, NodeId, Point, Rect } from "../scene/types";

export type SelectionPart = { readonly ids: readonly NodeId[]; readonly edgeIds: readonly EdgeId[] };

export interface PageSelectionSnapshot {
  /** The diagram holding the page's most recent selection; null when none holds one. */
  readonly focused: string | null;
  /** The last diagram focused or asked for, kept after its selection is gone. */
  readonly recent: string | null;
  /** Every diagram holding a selection, most recent first. */
  readonly parts: ReadonlyMap<string, SelectionPart>;
}

/**
 * Where the diagrams are, for a frame drawn around shapes in several of them:
 * a part's own selection box in its scene px, and the way from one diagram's
 * px to another's through the screen.
 */
export interface PageGeometry {
  bounds(blockId: string, ids: readonly NodeId[]): RotatedRect | null;
  toClient(blockId: string, point: Point): Point;
  toScene(blockId: string, point: Point): Point;
}

/**
 * One selection over every diagram on a page.
 *
 * Each diagram keeps its own selection store, and every way a store changes —
 * a click, a marquee, the layers panel, an undo putting a selection back —
 * reaches this through the store's own subscription, so focus follows all of
 * them from one place. A selection that appears in one diagram clears the
 * others, unless it was added on purpose: a Shift-click, a ⌘-toggle, a
 * Shift-range in the layers, a marquee crossing several diagrams.
 */
export interface PageSelection {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PageSelectionSnapshot;
  attach(blockId: string, raw: SelectionStore): () => void;
  /**
   * A diagram's store with the page's meaning: what replaces a selection
   * replaces the page's, what adds to one adds across diagrams, and clearing
   * clears the page. Reads go straight to `raw`. The same object every call.
   */
  facade(blockId: string, raw: SelectionStore): SelectionStore;
  /** These ids in this diagram; `keep` leaves the others' selections alone. */
  selectIn(blockId: string, ids: readonly NodeId[], opts?: { keep?: boolean }): void;
  /** One diagram's share of a marquee that may cross several. */
  marqueeIn(blockId: string, rect: Rect, opts: { shift: boolean }): void;
  clearAll(except?: string): void;
  /**
   * Runs `fn` with every diagram's selection added to rather than replacing
   * the others' — a command that acts on each diagram holding a share of the
   * selection, and leaves each holding its share.
   */
  keep<T>(fn: () => T): T;
  focus(blockId: string): void;
  /** Selected shapes on the whole page. */
  count(): number;
  /**
   * The box around every selected shape on the page, in this diagram's scene
   * px. One diagram's own selection keeps its rotation; a box spanning several
   * has none.
   */
  unionIn(blockId: string): RotatedRect | null;
}

export interface PageSelectionDeps {
  batch<T>(fn: () => T): T;
  /** True while history is putting a selection back: it is restored, not made. */
  quiet?: () => boolean;
  geometry?: PageGeometry;
}

/** Whether shapes are held in more than one diagram. */
export function spansDiagrams(parts: ReadonlyMap<string, SelectionPart>): boolean {
  let holding = 0;
  for (const part of parts.values()) if (part.ids.length && ++holding > 1) return true;
  return false;
}

const NONE: readonly never[] = [];
const NO_PARTS: ReadonlyMap<string, SelectionPart> = new Map();
export const EMPTY_PAGE_SELECTION: PageSelectionSnapshot = { focused: null, recent: null, parts: NO_PARTS };

function sameParts(a: ReadonlyMap<string, SelectionPart>, b: ReadonlyMap<string, SelectionPart>) {
  if (a.size !== b.size) return false;
  const left = [...a];
  const right = [...b];
  return left.every(([id, part], i) => {
    const [otherId, other] = right[i];
    return id === otherId && part.ids === other.ids && part.edgeIds === other.edgeIds;
  });
}

type Held = { raw: SelectionStore; ids: readonly NodeId[]; edgeIds: readonly EdgeId[] };

export function createPageSelection(deps: PageSelectionDeps): PageSelection {
  const held = new Map<string, Held>();
  const facades = new Map<string, { raw: SelectionStore; store: SelectionStore }>();
  /** Diagrams holding a selection, most recent first. */
  let order: string[] = [];
  let snapshot = EMPTY_PAGE_SELECTION;
  let adding = false;
  const listeners = new Set<() => void>();

  const publish = (asked?: string) => {
    const parts = new Map<string, SelectionPart>();
    for (const id of order) {
      const entry = held.get(id)!;
      parts.set(id, { ids: entry.ids, edgeIds: entry.edgeIds });
    }
    const focused = order[0] ?? null;
    const next = { focused, recent: asked ?? focused ?? snapshot.recent, parts: parts.size ? parts : NO_PARTS };
    if (
      next.focused === snapshot.focused &&
      next.recent === snapshot.recent &&
      sameParts(next.parts, snapshot.parts)
    ) {
      return;
    }
    const kept = sameParts(next.parts, snapshot.parts) ? snapshot.parts : next.parts;
    snapshot = { ...next, parts: kept };
    for (const listener of listeners) listener();
  };

  const clearOthers = (except?: string) => {
    for (const id of [...order]) if (id !== except) held.get(id)?.raw.clear();
  };

  const clearAll = (except?: string) => {
    if (order.some((id) => id !== except)) deps.batch(() => clearOthers(except));
  };

  const changed = (blockId: string) => {
    const entry = held.get(blockId);
    if (!entry) return;
    const { ids, edgeIds } = entry.raw.getSnapshot();
    // Hover moves the snapshot too, and hover is nobody's selection.
    if (ids === entry.ids && edgeIds === entry.edgeIds) return;
    entry.ids = ids;
    entry.edgeIds = edgeIds;
    order = order.filter((id) => id !== blockId);
    if (ids.length === 0 && edgeIds.length === 0) return publish();
    order.unshift(blockId);
    if (adding || deps.quiet?.()) return publish();
    deps.batch(() => {
      clearOthers(blockId);
      publish();
    });
  };

  /**
   * Shapes added in one diagram keep the others' shapes, never their
   * connectors: the panels speak for shapes or for connectors, not both.
   */
  const keepKind = (blockId: string) => {
    if (!held.get(blockId)?.ids.length) return;
    for (const id of [...order]) {
      const other = held.get(id)!;
      if (id !== blockId && other.edgeIds.length) other.raw.clear();
    }
  };

  const additive = <T,>(blockId: string, fn: () => T): T => {
    const was = adding;
    adding = true;
    try {
      return deps.batch(() => {
        const out = fn();
        keepKind(blockId);
        return out;
      });
    } finally {
      adding = was;
    }
  };

  /*
   * The store tells its listeners before it records the step, so a change that
   * reaches it outside a batch would land as two steps: this page's reply —
   * the others cleared, the focus moved — closing first, the selection itself
   * after. Every way the facade changes a selection runs inside one.
   */
  const within = <T,>(fn: () => T): T => deps.batch(fn);

  const replacing = <T,>(blockId: string, fn: () => T): T =>
    deps.batch(() => {
      clearOthers(blockId);
      return fn();
    });

  const unionIn = (blockId: string): RotatedRect | null => {
    const geometry = deps.geometry;
    if (!geometry) return null;
    const holding = order.filter((id) => held.get(id)!.ids.length > 0);
    if (holding.length === 0) return null;
    if (holding.length === 1 && holding[0] === blockId) {
      return geometry.bounds(blockId, held.get(blockId)!.ids);
    }
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const id of holding) {
      const frame = geometry.bounds(id, held.get(id)!.ids);
      if (!frame) continue;
      const box = nodeBounds(frame);
      // Scale and offset are all that separate two diagrams' px, so two
      // corners carry the whole box across.
      const a = geometry.toScene(blockId, geometry.toClient(id, { x: box.x, y: box.y }));
      const b = geometry.toScene(blockId, geometry.toClient(id, { x: box.x + box.w, y: box.y + box.h }));
      x1 = Math.min(x1, a.x, b.x);
      y1 = Math.min(y1, a.y, b.y);
      x2 = Math.max(x2, a.x, b.x);
      y2 = Math.max(y2, a.y, b.y);
    }
    return x1 <= x2 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1, rot: 0 } : null;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    attach: (blockId, raw) => {
      const entry: Held = { raw, ids: NONE, edgeIds: NONE };
      held.set(blockId, entry);
      const off = raw.subscribe(() => changed(blockId));
      changed(blockId);
      return () => {
        off();
        if (facades.get(blockId)?.raw === raw) facades.delete(blockId);
        if (held.get(blockId) !== entry) return;
        held.delete(blockId);
        order = order.filter((id) => id !== blockId);
        publish();
      };
    },
    facade: (blockId, raw) => {
      const known = facades.get(blockId);
      if (known?.raw === raw) return known.store;
      const store: SelectionStore = {
        ...raw,
        select: (ids) => replacing(blockId, () => raw.select(ids)),
        // Not yet on the page — mounted, not registered — it is only itself.
        clear: () => (held.has(blockId) ? clearAll() : raw.clear()),
        // Empty canvas under a plain click clears the page, not just the
        // diagram it landed in.
        click: (point, mods) =>
          mods?.shift
            ? additive(blockId, () => raw.click(point, mods))
            : replacing(blockId, () => raw.click(point, mods)),
        toggle: (id) => additive(blockId, () => raw.toggle(id)),
        escape: () => {
          if (raw.getSnapshot().enteredPath.length === 0 && held.has(blockId)) clearAll();
          else replacing(blockId, () => raw.escape());
        },
        marquee: (rect, mods) =>
          mods?.shift
            ? additive(blockId, () => raw.marquee(rect, mods))
            : replacing(blockId, () => raw.marquee(rect, mods)),
        // A connector joins two shapes of one diagram, so a connector
        // selection never reaches past it.
        selectEdges: (ids) => replacing(blockId, () => raw.selectEdges(ids)),
        toggleEdge: (id) => replacing(blockId, () => raw.toggleEdge(id)),
        // What may leave the selection where it is, and so the others too.
        selectAll: () => within(() => raw.selectAll()),
        enter: (point, opts) => within(() => raw.enter(point, opts)),
        enterSelected: () => within(() => raw.enterSelected()),
        selectParent: () => within(() => raw.selectParent()),
        selectSibling: (direction) => within(() => raw.selectSibling(direction)),
      };
      facades.set(blockId, { raw, store });
      return store;
    },
    selectIn: (blockId, ids, opts) => {
      const entry = held.get(blockId);
      if (!entry) return;
      if (opts?.keep) additive(blockId, () => entry.raw.select(ids));
      else replacing(blockId, () => entry.raw.select(ids));
    },
    marqueeIn: (blockId, rect, { shift }) => {
      const entry = held.get(blockId);
      if (entry) additive(blockId, () => entry.raw.marquee(rect, { shift }));
    },
    clearAll,
    keep: (fn) => {
      const was = adding;
      adding = true;
      try {
        return fn();
      } finally {
        adding = was;
      }
    },
    focus: (blockId) => {
      if (!held.has(blockId)) return;
      if (order.includes(blockId)) order = [blockId, ...order.filter((id) => id !== blockId)];
      publish(blockId);
    },
    count: () => order.reduce((total, id) => total + held.get(id)!.ids.length, 0),
    unionIn,
  };
}
