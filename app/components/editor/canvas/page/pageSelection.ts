import type { SelectionStore } from "../engine/useSelection";
import type { EdgeId, NodeId } from "../scene/types";

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
 * One selection over every diagram on a page.
 *
 * Each diagram keeps its own selection store, and every way a store changes —
 * a click, a marquee, the layers panel, an undo putting a selection back —
 * reaches this through the store's own subscription, so focus follows all of
 * them from one place. A selection that appears in one diagram clears the
 * others, unless it was added on purpose.
 */
export interface PageSelection {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PageSelectionSnapshot;
  attach(blockId: string, raw: SelectionStore): () => void;
  select(blockId: string, ids: readonly NodeId[], opts?: { additive?: boolean }): void;
  clearAll(except?: string): void;
  focus(blockId: string): void;
  isSelected(blockId: string, id: NodeId): boolean;
}

export interface PageSelectionDeps {
  batch<T>(fn: () => T): T;
  /** True while history is putting a selection back: it is restored, not made. */
  quiet?: () => boolean;
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
        if (held.get(blockId) !== entry) return;
        held.delete(blockId);
        order = order.filter((id) => id !== blockId);
        publish();
      };
    },
    select: (blockId, ids, opts) => {
      const entry = held.get(blockId);
      if (!entry) return;
      adding = opts?.additive === true;
      try {
        deps.batch(() => entry.raw.select(ids));
      } finally {
        adding = false;
      }
    },
    clearAll: (except) => {
      if (order.some((id) => id !== except)) deps.batch(() => clearOthers(except));
    },
    focus: (blockId) => {
      if (!held.has(blockId)) return;
      if (order.includes(blockId)) order = [blockId, ...order.filter((id) => id !== blockId)];
      publish(blockId);
    },
    isSelected: (blockId, id) => held.get(blockId)?.raw.isSelected(id) ?? false,
  };
}
