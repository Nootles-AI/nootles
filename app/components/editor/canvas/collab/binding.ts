import type * as Y from "yjs";
import type { SceneStore } from "../engine/useScene";
import { migrateLegacyCanvas } from "../scene/migrate";
import { setMintTag } from "../scene/ops";
import { serializeScene } from "../scene/serialize";
import type { Scene } from "../scene/types";

/**
 * Minted ids get a session suffix the moment any diagram is shared: two
 * people drawing at the same instant both count `n7` off the same scene, and
 * without the tag those are one shape with two authors. Once per session —
 * the tag is identity, not data.
 */
let tagged = false;
function ensureMintTag() {
  if (tagged) return;
  tagged = true;
  setMintTag(Math.random().toString(36).slice(2, 4));
}
import {
  applySceneDiff,
  CANVAS_EXTERNAL,
  CANVAS_LOCAL,
  CANVAS_MIGRATE,
  canvasMapName,
  hasCanvasState,
  materializeCanvas,
  populateCanvas,
} from "./ymap";

/**
 * One diagram's bridge between the SceneStore and its CRDT maps.
 *
 * The store keeps speaking the language it always has — canvas HTML in, canvas
 * HTML out — and this class converts at the boundary: a local flush is parsed
 * and DIFFED into per-shape map writes (so a gesture ships as the keys it
 * touched, and two people's gestures merge), and any transaction from
 * elsewhere — a collaborator, a fork merging, the migration racing on another
 * client — is materialized back to HTML and adopted.
 *
 * The block prop stays alive as a MIRROR: the serialized HTML is still written
 * onto the block, so every reader of the old contract — thumbnails,
 * `read_page`, copy/paste, the AI's whole-document projection — keeps working
 * unchanged. The mirror is display-grade, and trails on a cadence of its own
 * (see `blocks/CanvasBlock.tsx`) rather than on the store's flush: it is a
 * whole diagram per write where the maps are a shape per write. The maps are
 * the truth. An incoming prop change that does not
 * match the current maps is an EXTERNAL author — the AI writing a whole
 * diagram — and diffs in like anything else, which is what upgrades even
 * whole-HTML writes to per-shape merges.
 */
export class CanvasCollab {
  private root: Y.Map<unknown> | null = null;
  private doc: Y.Doc | null = null;
  private store: SceneStore | null = null;
  /**
   * What this client last knew the diagram to be — the store's own state.
   * Every local write diffs against THIS, never against the live maps, so a
   * concurrent edit that has not been adopted yet can never read as a
   * deletion or as staleness to overwrite (see applySceneDiff).
   */
  private known: Scene | null = null;
  /** The last HTML this client wrote to the block prop (or saw at attach). */
  lastMirrored: string | null = null;
  /**
   * Recent map states. A peer's block-prop mirror is a LAGGING projection —
   * written on their flush cadence while their map writes stream ahead — so
   * "differs from the maps now" cannot mean "external author". Anything
   * matching a recent state is a mirror echo and is ignored; only content the
   * maps have NEVER said (the AI writing a whole diagram) adopts.
   *
   * Held as the scenes they were, and serialized only when a block-prop change
   * actually arrives to be compared against: preparing for that arrival on
   * every committed edit is the edit paying the arrival's bill.
   */
  private recent: { scene: Scene; html: string | null }[] = [];

  constructor(private blockId: string) {}

  get attached(): boolean {
    return this.root !== null;
  }

  /**
   * Bind to (or rebind after a fork swap onto) a document. If the diagram has
   * never been in the CRDT, the block prop's HTML populates it —
   * deterministically, so a second client doing the same converges rather
   * than colliding (see ymap.ts).
   */
  attach(doc: Y.Doc, propSource: string) {
    ensureMintTag();
    this.detach();
    this.doc = doc;
    this.root = doc.getMap<unknown>(canvasMapName(this.blockId));
    if (!hasCanvasState(this.root) && propSource.trim()) {
      const scene = migrateLegacyCanvas(propSource);
      doc.transact(() => populateCanvas(this.root!, scene), CANVAS_MIGRATE);
    }
    this.lastMirrored = propSource;
    this.known = hasCanvasState(this.root)
      ? materializeCanvas(this.root)
      : null;
    this.root.observeDeep(this.onDeep);
    // The maps may already be ahead of whatever the store was seeded with.
    this.pushToStore();
  }

  detach() {
    this.root?.unobserveDeep(this.onDeep);
    this.root = null;
    this.doc = null;
  }

  setStore(store: SceneStore | null) {
    if (this.store === store) return;
    this.store?.setLiveWriter(null);
    this.store = store;
    if (store) {
      // Committed scenes stream to the maps the moment they exist; the
      // debounced HTML flush keeps feeding the block-prop mirror behind it.
      store.setLiveWriter((scene) => {
        if (!this.root || !this.doc) return;
        this.doc.transact(
          () => applySceneDiff(this.root!, this.known, scene),
          CANVAS_LOCAL,
        );
        this.known = scene;
        this.note(materializeCanvas(this.root));
      });
      this.pushToStore();
    }
  }

  /** The HTML the store should be born with — the maps' state when they have one. */
  seed(propSource: string): string {
    if (this.root && hasCanvasState(this.root)) {
      return serializeScene(materializeCanvas(this.root));
    }
    return propSource;
  }

  private note(scene: Scene, html: string | null = null) {
    if (this.recent[this.recent.length - 1]?.scene === scene) return;
    this.recent.push({ scene, html });
    if (this.recent.length > 24) this.recent.shift();
  }

  /** Whether this HTML is one of the states the maps have already been in.
   *  Newest first: a mirror lags by an edit or two, so an echo is recognised
   *  after a serialization or two and only a genuine external author pays for
   *  the whole window. */
  private echoes(html: string): boolean {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const entry = this.recent[i];
      entry.html ??= serializeScene(entry.scene);
      if (entry.html === html) return true;
    }
    return false;
  }

  /** A local flush: HTML from the store, per-shape writes to the maps. */
  writeLocal(html: string, scene?: Scene) {
    if (!this.root || !this.doc) return;
    this.lastMirrored = html;
    // The live writer streamed this very scene into the maps as it was
    // committed; the flush is the same edit arriving again as a string.
    if (scene && scene === this.known) return;
    const next = scene ?? migrateLegacyCanvas(html);
    this.doc.transact(
      () => applySceneDiff(this.root!, this.known, next),
      CANVAS_LOCAL,
    );
    // The store now believes `next`; the next flush diffs against it.
    this.known = next;
    this.note(materializeCanvas(this.root));
  }

  /**
   * A block-prop change this client did not mirror: either a collaborator's
   * mirror (whose map writes have already arrived, so the diff is empty and
   * nothing happens) or a genuine external author — the AI. The latter lands
   * in the maps AND in the store as a normal, undoable adoption.
   */
  adoptExternal(html: string) {
    if (!this.root || !this.doc) return;
    this.lastMirrored = html;
    if (this.echoes(html)) return; // a mirror echo, however lagged
    const before = serializeScene(materializeCanvas(this.root));
    if (html === before) return;
    const next = migrateLegacyCanvas(html);
    this.doc.transact(
      () => applySceneDiff(this.root!, this.known, next),
      CANVAS_EXTERNAL,
    );
    const merged = materializeCanvas(this.root);
    const after = serializeScene(merged);
    this.known = merged;
    if (after !== before) this.store?.setSource(after);
  }

  /** Anything not ours: a collaborator, an undo replay, a fork merging. */
  private onDeep = (_events: unknown, transaction: Y.Transaction) => {
    if (
      transaction.origin === CANVAS_LOCAL ||
      transaction.origin === CANVAS_EXTERNAL ||
      transaction.origin === CANVAS_MIGRATE
    ) {
      return;
    }
    this.pushToStore();
  };

  private pushToStore() {
    if (!this.root || !hasCanvasState(this.root)) return;
    const merged = materializeCanvas(this.root);
    this.known = merged;
    if (!this.store) return;
    // Against the store's LIVE scene, not its last flush: setStore re-runs on
    // every api republish (each tool change), and mid-edit the maps are
    // always ahead of the flushed HTML — adopting then would wipe the undo
    // history for an "arrival" that is just the store's own unflushed work.
    const html = serializeScene(merged);
    this.note(merged, html);
    if (serializeScene(this.store.getScene()) !== html) {
      this.store.adoptRemote(html);
    }
  }
}
