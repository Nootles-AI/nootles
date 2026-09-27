import type * as Y from "yjs";
import type { SceneStore } from "../engine/useScene";
import { normalizeDiagram } from "../scene/band";
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
export function ensureCollaborativeCanvasMintTag() {
  if (tagged) return;
  tagged = true;
  setMintTag(Math.random().toString(36).slice(2, 4));
}
import {
  applySceneDiff,
  CANVAS_EDIT_KEY as EDIT,
  CANVAS_EXTERNAL,
  CANVAS_LOCAL,
  CANVAS_MIGRATE,
  CANVAS_MIRROR_KEY as MIRROR,
  canvasMapName,
  hasCanvasState,
  materializeCanvas,
  mirrorStamp,
  populateCanvas,
} from "./ymap";

/** How many recent stamps still identify a mirror (see `stamps`). */
const STAMPS = 8;

/**
 * The transaction meta a block's mirror write carries, so the rest of the
 * editor can tell it from an edit. The mirror is the block's own bookkeeping —
 * it lands on a trailing cadence, long after the gesture it describes, and
 * nobody typed it. A review counting one as the person rewriting the block made
 * a diagram change undiscardable five seconds after anyone nudged a shape
 * (NT-70, `ReviewOverlay`).
 */
export const CANVAS_MIRROR_META = "nt-canvas-mirror";

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
 * the truth. A prop change no client marked as its mirror is an EXTERNAL
 * author — a whole diagram written without the maps — and diffs in like
 * anything else, which is what upgrades even whole-HTML writes to per-shape
 * merges.
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
   * Mirror stamps the maps have carried lately, this client's own among them.
   * A prop bearing one is somebody's mirror, however far it trails and
   * whatever changed since it was flushed: its writer's map writes went first,
   * so diffing it in could only take edits back. Several rather than the
   * current one, because the prop a render hands over can be a beat behind a
   * stamp that has already moved on.
   */
  private stamps: string[] = [];
  /** The mirror this client last put on the block, and its stamp. */
  private mirrored: { html: string; stamp: string } | null = null;
  /**
   * The {@link EDIT} token as this client last took it into its scene. A token
   * that has moved since is somebody's work; one that has not is the browser's
   * housekeeping, whatever else changed with it.
   */
  private lastEdit: unknown = null;
  /** This binding's own mark, and the count of edits it has made under it. */
  private readonly mint = Math.random().toString(36).slice(2, 10);
  private edits = 0;
  private staleMirror: ((html: string) => void) | null = null;
  /**
   * Recent map states, for a mirror that arrives without a stamp — from a
   * client that predates them. A peer's mirror is a LAGGING projection, so
   * "differs from the maps now" cannot mean "external author": anything
   * matching a recent state is taken for an echo. What this cannot recognise
   * is a mirror flushed while someone else was editing too, which describes a
   * state no other replica was ever in; the stamp is what does.
   *
   * Held as the scenes they were, and serialized only when a block-prop change
   * actually arrives to be compared against: preparing for that arrival on
   * every committed edit is the edit paying the arrival's bill.
   */
  private recent: { scene: Scene; html: string | null }[] = [];
  /**
   * Whether the doc is a review's private fork. Nobody else writes there, so no
   * prop change is a collaborator's lagging mirror — and none is the person's
   * own edit either: it is the agent proposing, or the review answering.
   */
  private forked = false;

  constructor(private blockId: string) {}

  get attached(): boolean {
    return this.root !== null;
  }

  /**
   * Bind to (or rebind after a fork swap onto) a document. `propSource` is the
   * block prop as the block last reconciled it: at mount, the prop itself; on a
   * rebind, not whatever the prop has become, because the task that swapped the
   * doc may already have written into it — a review forks the editor and
   * writes its proposal in one go. If the diagram has never been in the CRDT,
   * that HTML populates it — deterministically, so a second client doing the
   * same converges rather than colliding (see ymap.ts).
   */
  attach(doc: Y.Doc, propSource: string, forked = false) {
    ensureCollaborativeCanvasMintTag();
    this.detach();
    this.doc = doc;
    this.forked = forked;
    this.root = doc.getMap<unknown>(canvasMapName(this.blockId));
    this.stamps = [];
    this.mirrored = null;
    this.noteStamp();
    if (!hasCanvasState(this.root) && propSource.trim()) {
      const scene = migrateLegacyCanvas(propSource);
      doc.transact(() => populateCanvas(this.root!, scene), CANVAS_MIGRATE);
    }
    this.lastMirrored = propSource;
    this.known = hasCanvasState(this.root)
      ? materializeCanvas(this.root)
      : null;
    // Read, not reset: a diagram from before this key existed carries none,
    // and an absent token must compare equal to the next absent one.
    this.lastEdit = this.root.get(EDIT);
    this.root.observeDeep(this.onDeep);
    // The maps may already be ahead of whatever the store was seeded with —
    // and a warm store's history predates whatever arrived while it was away,
    // so this first reconciliation is a remote one whatever the token says.
    this.pushToStore(true);
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
      store.setLiveWriter((scene, edit) => {
        if (!this.root || !this.doc) return;
        this.doc.transact(() => {
          applySceneDiff(this.root!, this.known, scene);
          if (edit) this.markEdit();
        }, CANVAS_LOCAL);
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

  /**
   * The mirror to write onto the block now, marked as this client's; the block
   * writes it straight after, in the same task. It is the maps as they stand,
   * not the flush that asked for it (`pending`): a collaborator's edit can have
   * arrived in between, and a mirror without it would keep the block short of
   * that edit for as long as the mirror stands.
   */
  stampMirror(pending: string): string {
    if (!this.root || !this.doc) return pending;
    const html = hasCanvasState(this.root)
      ? serializeScene(materializeCanvas(this.root))
      : pending;
    const stamp = mirrorStamp(html);
    this.mirrored = { html, stamp };
    if (this.root.get(MIRROR) !== stamp) {
      this.doc.transact(() => this.root!.set(MIRROR, stamp), CANVAS_LOCAL);
    }
    this.noteStamp();
    return html;
  }

  /**
   * Mark this write as something a person or an agent DID. Call inside the
   * same transaction as the shape writes, so the two reach a peer together and
   * cannot be told apart in time.
   */
  private markEdit() {
    if (!this.root) return;
    // Counted as well as random: two edits in one millisecond must not mint
    // the same token, or the second reads as nobody's doing.
    this.edits += 1;
    const token = `${this.mint}.${this.edits.toString(36)}`;
    this.root.set(EDIT, token);
    this.lastEdit = token;
  }

  private noteStamp() {
    const stamp = this.root?.get(MIRROR);
    if (typeof stamp !== "string" || this.stamps.includes(stamp)) return;
    this.stamps.push(stamp);
    if (this.stamps.length > STAMPS) this.stamps.shift();
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
    this.doc.transact(() => {
      applySceneDiff(this.root!, this.known, next);
      this.markEdit();
    }, CANVAS_LOCAL);
    // The store now believes `next`; the next flush diffs against it.
    this.known = next;
    this.note(materializeCanvas(this.root));
  }

  /**
   * A block-prop change this client did not mirror: either a collaborator's
   * mirror (stamped, or matching a state the maps have been in, and ignored)
   * or a genuine external author. The latter lands in the maps AND in the
   * store as a normal, undoable adoption.
   *
   * An `authored` change is the review writing: a proposal or its answer on a
   * review's fork, where nobody else writes, or a rewind on the shared doc.
   * Neither is an echo, though either can be a prop the maps have already been
   * — a discard writes back the diagram a proposal replaced. Nor is either the
   * person's edit: it is adopted off their undo, as the review's text writes
   * are, or ⌘Z would take back a proposal the review is still asking about, or
   * bring back one it was told to discard.
   */
  adoptExternal(html: string, authored = this.forked) {
    if (!this.root || !this.doc) return;
    this.lastMirrored = html;
    if (!authored && (this.stamps.includes(mirrorStamp(html)) || this.echoes(html))) {
      return; // a collaborator's mirror, however lagged
    }
    const before = serializeScene(materializeCanvas(this.root));
    if (html === before) return;
    const next = migrateLegacyCanvas(html);
    this.doc.transact(() => {
      applySceneDiff(this.root!, this.known, next);
      this.markEdit();
    }, CANVAS_EXTERNAL);
    const merged = materializeCanvas(this.root);
    const after = serializeScene(merged);
    this.known = merged;
    if (after === before || !this.store) return;
    if (authored) this.store.adoptRemote(after);
    else this.store.setSource(after);
  }

  /** Anything not ours: a collaborator, an undo replay, a fork merging. */
  private onDeep = (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
  ) => {
    if (
      transaction.origin === CANVAS_LOCAL ||
      transaction.origin === CANVAS_EXTERNAL ||
      transaction.origin === CANVAS_MIGRATE
    ) {
      return;
    }
    this.noteStamp();
    // Someone marking their mirror, or noting an edit that moved nothing,
    // moved no shape.
    const bookkeepingOnly = events.every(
      (event) =>
        event.target === this.root &&
        [...(event as Y.YMapEvent<unknown>).keysChanged].every(
          (key) => key === MIRROR || key === EDIT,
        ),
    );
    if (bookkeepingOnly) {
      // Their edit changed no map, so nothing here is out of date; taking the
      // token now keeps the next housekeeping change from reading as theirs.
      this.lastEdit = this.root?.get(EDIT);
      return;
    }
    this.pushToStore();
  };

  /**
   * How the block learns that the mirror on it has fallen behind the maps and
   * is this client's to write again; returns how to stop.
   */
  onStaleMirror(listener: (html: string) => void): () => void {
    this.staleMirror = listener;
    return () => {
      if (this.staleMirror === listener) this.staleMirror = null;
    };
  }

  private pushToStore(reattach = false) {
    if (!this.root || !hasCanvasState(this.root)) return;
    const merged = materializeCanvas(this.root);
    this.known = merged;
    // Read before anything is adopted, and taken whether or not there is a
    // store to tell: what has been seen is a fact about this client.
    const token = this.root.get(EDIT);
    // Quiet only UNDER a token somebody has minted. A diagram written before
    // this key existed carries none, and so does a client too old to mint one
    // — and staying quiet for either would let ⌘Z revert work this client
    // cannot see. It costs the fix nothing: a horizon you can lose is one you
    // made an edit to get, and that edit minted the token.
    const edited =
      reattach || typeof token !== "string" || token !== this.lastEdit;
    this.lastEdit = token;
    if (!this.store) return;
    // Against the store's LIVE scene, not its last flush: setStore re-runs on
    // every api republish (each tool change), and mid-edit the maps are
    // always ahead of the flushed HTML — adopting then would wipe the undo
    // history for an "arrival" that is just the store's own unflushed work.
    const html = serializeScene(merged);
    this.note(merged, html);
    // While the block still carries this client's mirror, nobody else will
    // bring it up to date: every reader of the prop — the AI's projection
    // among them — would go on reading the diagram without what just arrived.
    if (
      this.mirrored &&
      this.mirrored.html !== html &&
      this.root.get(MIRROR) === this.mirrored.stamp
    ) {
      this.staleMirror?.(html);
    }
    // Compared as bands on both sides. The store reads through
    // `migrateLegacyCanvas`, so it holds the band an old-format diagram reads
    // as; and a local edit can leave it holding less height than its content
    // is drawn at. Raw against either, the two would never match, and a
    // remount would cost a warm store its history (and its pending flush) for
    // nothing.
    const band = normalizeDiagram(merged);
    const want = band === merged ? html : serializeScene(band);
    if (serializeScene(normalizeDiagram(this.store.getScene())) === want) return;
    // Somebody's work costs the horizon; the browser's own housekeeping — a
    // measured box, a hoisted picture — must not (NT-27).
    if (edited) this.store.adoptRemote(html);
    else this.store.adoptQuiet(html);
  }
}

const settles = new WeakMap<Y.Doc, Set<() => void>>();

/**
 * Brings every diagram bound to `doc` in line with its block prop, now.
 *
 * A block reconciles its maps with its prop from an effect, a render after the
 * prop changes. The review writes a page and then, in the same task, lands the
 * fork it wrote into or ends the doc's history. Without this a fork lands with
 * the maps as the answer found them — a discarded shape reaching everyone while
 * its block says it is gone — and a rewind's diagram arrives a render late,
 * where it reads as a collaborator's lagging mirror and is ignored.
 */
export function settleDiagrams(doc: Y.Doc) {
  for (const settle of [...(settles.get(doc) ?? [])]) settle();
}

/** How a diagram's block takes part in {@link settleDiagrams}; returns how to stop. */
export function onDiagramSettle(doc: Y.Doc, settle: () => void): () => void {
  const held = settles.get(doc) ?? new Set<() => void>();
  settles.set(doc, held);
  held.add(settle);
  return () => {
    held.delete(settle);
  };
}
