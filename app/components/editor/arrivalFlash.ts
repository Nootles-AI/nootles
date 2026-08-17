import { createExtension } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { Node } from "prosemirror-model";

/**
 * The arrival flash, as decorations — the one way a transient class survives
 * the editor: node views are redrawn on every decoration pass (each awareness
 * tick, each remote update), and anything added to their DOM by hand is wiped
 * the same frame. A decoration IS the redraw, so it persists exactly as long
 * as the plugin says.
 *
 * What it says: blocks named by a collaborator's accept signal (fimFlash)
 * wear `nt-fim-arrive` — or `nt-fim-arrive-canvas` for a diagram, whose
 * shapes come up through a gold-stroked veil — until the caller clears them.
 * Decorations only; the document is never touched, so nothing here can sync.
 */

const flashKey = new PluginKey<DecorationSet>("nt-arrival-flash");

type FlashMeta = { add?: string[]; remove?: string[] };

/** How long the whole arrival runs before its decorations come down. */
const FLASH_MS = 2200;

/**
 * Blocks ARMED to flash the moment they arrive. Keyed globally by block id
 * (ids are UUIDs, unique across documents): the marker travels in the same
 * sync flush as the content, the doc-level listener arms these BEFORE the
 * editor's sync plugin dispatches, and `apply` below decorates the insertion
 * in that very transaction — so the first painted frame is already gold.
 * Late arming (content beat the marker) falls back to flashBlocksInView.
 */
const armed = new Map<string, number>();
const ARM_TTL_MS = 5000;

export function armFlash(ids: string[]) {
  const now = Date.now();
  // Arms whose content never came (an accept undone mid-flight, a marker for
  // a doc this client since left) must not pile up across a long session.
  for (const [id, until] of armed) {
    if (until < now) armed.delete(id);
  }
  const until = now + ARM_TTL_MS;
  for (const id of ids) armed.set(id, until);
}

function decorate(doc: Node, ids: string[]): Decoration[] {
  const wanted = new Set(ids);
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (wanted.has(node.attrs.id as string)) {
      const isCanvas =
        node.firstChild?.type.name === "canvas" || node.type.name === "canvas";
      found.push(
        Decoration.node(
          pos,
          pos + node.nodeSize,
          { class: isCanvas ? "nt-fim-arrive-canvas" : "nt-fim-arrive" },
          { id: node.attrs.id as string, until: Date.now() + FLASH_MS },
        ),
      );
    }
    // Ids live on block-level nodes; skip descending into inline content,
    // which is nearly the whole tree in a text-heavy document.
    return !node.isTextblock;
  });
  return found;
}

function arrivalFlashPlugin() {
  return new Plugin<DecorationSet>({
    key: flashKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(flashKey) as FlashMeta | undefined;
        if (meta?.remove?.length) {
          const gone = new Set(meta.remove);
          next = next.remove(
            next.find(undefined, undefined, (spec) => gone.has(spec.id)),
          );
        }
        if (meta?.add?.length) {
          // A re-flash replaces its predecessor rather than stacking a twin:
          // the class is identical, but the fresh `until` keeps the sweep
          // honest about how long this block has been gold.
          const again = new Set(meta.add);
          next = next.remove(
            next.find(undefined, undefined, (spec) => again.has(spec.id)),
          );
          next = next.add(tr.doc, decorate(tr.doc, meta.add));
        }
        // A transaction delivering an armed block: decorated HERE, in the
        // same state update that first renders it — never a frame of plain
        // ink before the gold. Any doc change qualifies: armed ids are UUIDs
        // another client just minted, so only sync can materialize them —
        // checking the sync plugin's meta would couple this to a vendor
        // string for no extra truth.
        if (armed.size && tr.docChanged) {
          const now = Date.now();
          const landed: string[] = [];
          for (const [id, until] of armed) {
            if (until < now) {
              armed.delete(id);
              continue;
            }
            landed.push(id);
          }
          if (landed.length) {
            const fresh = decorate(tr.doc, landed);
            if (fresh.length) {
              for (const d of fresh) armed.delete(d.spec.id as string);
              next = next.add(tr.doc, fresh);
            }
          }
        }
        // Spent decorations come down on whatever transaction lands first;
        // the timer below guarantees one arrives. Guarded so the sweep costs
        // nothing on the overwhelmingly common flash-free keystroke.
        if (next !== DecorationSet.empty) {
          const now = Date.now();
          const spent = next.find(
            undefined,
            undefined,
            (spec) => typeof spec.until === "number" && spec.until < now,
          );
          if (spent.length) next = next.remove(spent);
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        return flashKey.getState(state);
      },
    },
    // A spent class must actually LEAVE the DOM: in an idle document the sweep
    // above never runs, and a later flash of the same block (two accepts into
    // one paragraph) would re-apply a class the browser never saw change —
    // restarting nothing. The timer dispatches the sweep at the earliest
    // expiry, so gold always ends on time and can always begin again.
    view(editorView) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let known: DecorationSet | null = null;
      const schedule = () => {
        const set = flashKey.getState(editorView.state) ?? DecorationSet.empty;
        if (set === known) return;
        known = set;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        let earliest = Infinity;
        for (const d of set.find()) {
          const until = d.spec.until as unknown;
          if (typeof until === "number" && until < earliest) earliest = until;
        }
        if (earliest === Infinity) return;
        timer = setTimeout(
          () => {
            timer = null;
            editorView.dispatch(
              editorView.state.tr.setMeta(flashKey, {} satisfies FlashMeta),
            );
          },
          // Two frames past expiry, so removal never clips the final frame.
          Math.max(0, earliest - Date.now()) + 32,
        );
      };
      schedule();
      return {
        update: schedule,
        destroy() {
          if (timer !== null) clearTimeout(timer);
        },
      };
    },
  });
}

/**
 * Flash blocks that are ALREADY on screen — the fallback when a marker
 * arrives after its content (a reload mid-flight, a signal that lost the
 * race). They expire through the same spec-based sweep as armed arrivals.
 */
export function flashBlocksInView(view: EditorView, ids: string[]) {
  // Callers defer out of observer windows, so the view may have been torn
  // down (unmount, StrictMode's double pass) between the signal and now.
  if (!ids.length || view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(flashKey, { add: ids } satisfies FlashMeta));
}

export const arrivalFlashExtension = createExtension({
  key: "arrivalFlash",
  prosemirrorPlugins: [arrivalFlashPlugin()],
});
