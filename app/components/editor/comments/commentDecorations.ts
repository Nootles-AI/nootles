import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceStep, StepMap } from "prosemirror-transform";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { ySyncPluginKey } from "y-prosemirror";
import { isReviewWriting } from "@/app/lib/ai/review/attribution";
import { anchorAt } from "@/app/lib/comments/anchor";
import { offsetAt, pmBlockTexts, pmRange, type PmBlockText } from "@/app/lib/comments/pmText";
import { hasWrites, resolveAnchor, validateAnchor, type ResolutionWrite } from "@/app/lib/comments/resolve";
import type { Thread } from "@/app/lib/comments/types";

/**
 * Comment highlights as live ranges (design §3, "Durable anchor, live range").
 *
 * A thread's quote selector is resolved against the text ONCE — when the
 * thread first reaches this editor — and the range it finds is then mapped
 * forward through every transaction, local and remote alike. Typing inside the
 * phrase grows the range, typing at either edge does not, and the selector is
 * not consulted again until the mapping says every character of the range is
 * gone — or, for a remote change, cannot say which of them are. Nothing is
 * ever written to the page: these are decorations.
 *
 * What a resolve asks the comments document to remember (a rewritten `exact`,
 * a re-homed block, an orphan mark) is handed to whoever persists it, through
 * `persistCommentWrites`, once per transaction. So is the one write the
 * mapping itself asks for: once the edits pause, words this editor typed or
 * deleted inside a range become the stored quotation, so a reload finds the
 * range the mapping had instead of chasing the old words. Only the editing
 * client writes it.
 *
 * The stored anchor is what every replica agrees on, so when it changes under
 * a replica that is not mid-edit on those words — another client settled,
 * re-homed or rewrote it — and no longer quotes its live range, the replica
 * moves the range to where the new anchor quotes verbatim. That is display
 * only: the writer already wrote. If the words it quotes have not arrived yet
 * (the page and its comments sync separately), the mapped range stays and the
 * move is tried again as remote changes land. Three rules keep all of this honest:
 *
 * - **Under a review fork nothing is resolved from the fork's text.** A range
 *   the proposal rewrites any of shows as unanchored and is left there; when
 *   the fork ends, every thread is resolved again against the shared
 *   document. No write is produced while a fork stands.
 * - **A live deletion writes nothing on the spot.** Cut is half of cut-and-
 *   paste, so a range deleted by an edit is re-resolved at once for display
 *   only; what it resolves to — an orphan, a fuzzy twin, a re-home — is
 *   decided and written by the settle pass that follows the edits by
 *   `SETTLE_MS`.
 * - **What another client's thread resolves to here is not written on first
 *   sight.** The page and its comments sync separately, so a thread can arrive
 *   before the words it quotes. A first sight that would write — a fuzzy
 *   rewrite, a re-home, an orphan mark — is shown and held `unconfirmed`; it
 *   is written only when a settle pass finds the same answer after a remote
 *   page change has landed since it was last seen.
 */

export type CommentRange = { from: number; to: number };

type Tracked = { thread: Thread; range: CommentRange | null };

type CommentsState = {
  tracked: ReadonlyMap<string, Tracked>;
  active: string | null;
  /**
   * The words a comment is being written about, before its thread exists —
   * shown as a focused highlight while the composer has the keyboard and the
   * page's own selection is gone. Mapped like a thread's range; never written.
   */
  draft: CommentRange | null;
  isForked: () => boolean;
  decorations: DecorationSet;
  /** What this transaction asks the comments document to remember. */
  writes: ReadonlyMap<string, ResolutionWrite>;
  /** Threads whose words this editor has edited since the settle pass last ran. */
  edited: ReadonlySet<string>;
  /** Threads re-resolved mid-edit for display only; the settle pass decides. */
  unsettled: ReadonlySet<string>;
  /** Threads whose new stored anchor quotes words this document has not received yet. */
  awaiting: ReadonlySet<string>;
  /**
   * Threads whose resolution here would write but has not been confirmed: the
   * writes it asked for, and whether a remote page change has landed since.
   */
  unconfirmed: ReadonlyMap<string, Unconfirmed>;
  /** Selector resolutions run so far — the count the tests hold down. */
  resolves: number;
};

type Unconfirmed = { writes: string; ticked: boolean };

/**
 * How a resolution is used. `display` shows it; `persist` also writes it;
 * `probe` shows it and holds any write unconfirmed; `tick` does the same after
 * a remote page change; `confirm` writes a held answer that has survived one.
 */
type Mode = "display" | "persist" | "probe" | "tick" | "confirm";

type Meta = {
  threads?: readonly Thread[];
  active?: string | null;
  draft?: CommentRange | null;
  /** Resolve every thread again. */
  resolve?: "all";
  /**
   * The edits have paused: look again for threads without a range, and make
   * the words edited inside a range the stored quotation.
   */
  settle?: true;
  isForked?: () => boolean;
};

export const commentKey = new PluginKey<CommentsState>("nt-comments");

/** How long the edits must pause before the settle pass runs. */
export const SETTLE_MS = 600;

const NO_WRITES: ReadonlyMap<string, ResolutionWrite> = new Map();
const NONE: ReadonlySet<string> = new Set();
const NO_UNCONFIRMED: ReadonlyMap<string, Unconfirmed> = new Map();
const notForked = () => false;

// ---- Mapping ----------------------------------------------------------------

/**
 * The maps a transaction moves positions by. y-prosemirror delivers every
 * remote change, undo and fork swap as ONE step replacing the whole document,
 * which maps every position inside it to "deleted"; for those the change is
 * re-derived as the one span where the two documents differ. The rebuilt
 * nodes of unchanged blocks are the cached originals, so the walk skips them
 * by identity. A derived span is not `exact`: two edits a sentence apart
 * arrive as one span covering the words between them.
 */
function mapsOf(tr: Transaction): { maps: readonly StepMap[]; exact: boolean } {
  const whole = tr.steps.some(
    (step, i) => step instanceof ReplaceStep && step.from === 0 && step.to === tr.docs[i].content.size,
  );
  if (!whole) return { maps: tr.mapping.maps as readonly StepMap[], exact: true };
  const diff = diffMap(tr.before, tr.doc);
  return { maps: diff ? [diff] : [], exact: false };
}

function diffMap(a: Node, b: Node): StepMap | null {
  const start = a.content.findDiffStart(b.content);
  if (start == null) return null;
  let { a: endA, b: endB } = a.content.findDiffEnd(b.content)!;
  // Repeated content lets the two walks cross; the change starts at `start`.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return new StepMap([start, endA - start, endB - start]);
}

/**
 * A range through `maps`, or null once none of its characters remain. The
 * start maps rightward and the end leftward, so text typed at either edge
 * lands outside it; a replacement that swallows the whole range deletes it,
 * even though new text now stands where it was.
 */
export function mapRange(range: CommentRange, maps: readonly StepMap[]): CommentRange | null {
  let { from, to } = range;
  for (const map of maps) {
    let swallowed = false;
    map.forEach((oldStart, oldEnd) => {
      if (oldStart < oldEnd && oldStart <= from && to <= oldEnd) swallowed = true;
    });
    if (swallowed) return null;
    from = map.map(from, 1);
    to = map.map(to, -1);
    if (to <= from) return null;
  }
  return from === range.from && to === range.to ? range : { from, to };
}

/**
 * Whether a changed span begins or ends strictly inside the range. From an
 * inexact map that means some of the range's words may have been rewritten and
 * some only look it, so the selector is asked rather than the map believed.
 */
export function straddles(range: CommentRange, maps: readonly StepMap[]): boolean {
  let hit = false;
  for (const map of maps) {
    map.forEach((oldStart, oldEnd) => {
      if (oldStart === oldEnd) return;
      if ((oldStart < range.from && range.from < oldEnd) || (oldStart < range.to && range.to < oldEnd)) hit = true;
    });
  }
  return hit;
}

/** Whether the maps changed any of the range's own characters, or typed among them. */
export function touches(range: CommentRange, maps: readonly StepMap[]): boolean {
  let hit = false;
  let { from, to } = range;
  for (const map of maps) {
    map.forEach((oldStart, oldEnd) => {
      if (oldStart === oldEnd ? from < oldStart && oldStart < to : oldStart < to && from < oldEnd) hit = true;
    });
    from = map.map(from, 1);
    to = map.map(to, -1);
  }
  return hit;
}

// ---- The plugin ---------------------------------------------------------------

function decorationsFor(
  doc: Node,
  tracked: ReadonlyMap<string, Tracked>,
  active: string | null,
  draft: CommentRange | null,
) {
  const decorations: Decoration[] = [];
  if (draft) {
    decorations.push(Decoration.inline(draft.from, draft.to, { class: "nt-comment-hl nt-comment-hl-active is-draft" }));
  }
  for (const [id, { thread, range }] of tracked) {
    if (!range || thread.status !== "open") continue;
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
        { class: id === active ? "nt-comment-hl nt-comment-hl-active" : "nt-comment-hl", "data-thread": id },
        { threadId: id },
      ),
    );
  }
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function sameAnchor(a: Thread, b: Thread): boolean {
  const x = a.anchor;
  const y = b.anchor;
  return (
    x.blockId === y.blockId &&
    x.exact === y.exact &&
    x.prefix === y.prefix &&
    x.suffix === y.suffix &&
    x.offsetHint === y.offsetHint
  );
}

/** The anchor `range` would mint now, or null if it quotes nothing. */
function mintedAt(range: CommentRange, blocks: readonly PmBlockText[]) {
  const block = blocks.find((candidate) => candidate.start <= range.from && range.to <= candidate.end);
  if (!block) return null;
  const anchor = anchorAt(block, offsetAt(block, range.from), offsetAt(block, range.to));
  return anchor.exact.trim() === "" ? null : anchor;
}

/**
 * Whether the stored anchor already quotes the live range. Context drifting
 * alone does not count: the quotation still finds itself.
 */
function quotes(entry: Tracked, blocks: readonly PmBlockText[]): boolean {
  const anchor = entry.range && mintedAt(entry.range, blocks);
  return !!anchor && anchor.exact === entry.thread.anchor.exact && anchor.blockId === entry.thread.anchor.blockId;
}

/**
 * The anchor the live range would mint now, when its words are no longer the
 * stored quotation — the edit the mapping followed, made durable.
 */
function refreshed(entry: Tracked, blocks: readonly PmBlockText[]): ResolutionWrite | null {
  const { range, thread } = entry;
  if (!range || quotes(entry, blocks)) return null;
  const anchor = mintedAt(range, blocks);
  if (!anchor) return null;
  const check = validateAnchor(anchor, blocks);
  const ambiguous = check.ok && check.ambiguous;
  return { anchor, ...(ambiguous !== thread.ambiguous ? { ambiguous } : {}) };
}

/** A change another client made, as y-prosemirror delivers it. */
function isRemote(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as
    | { isChangeOrigin?: boolean; isUndoRedoOperation?: boolean; binding?: unknown }
    | undefined;
  return !!sync?.isChangeOrigin && !sync.isUndoRedoOperation && sync.binding === undefined;
}

/**
 * Whether the person moved the caret. Remote changes and fork swaps restore
 * the caret too, and must not move the focus off a thread picked in the panel.
 */
const caretMoved = (tr: Transaction) => tr.selectionSet && tr.getMeta(ySyncPluginKey) === undefined;

function apply(tr: Transaction, prev: CommentsState): CommentsState {
  const meta = tr.getMeta(commentKey) as Meta | undefined;
  if (!meta && ((!prev.tracked.size && !prev.draft) || (!tr.docChanged && !caretMoved(tr)))) return prev;

  const isForked = meta?.isForked ?? prev.isForked;
  const forked = isForked();
  let changed = isForked !== prev.isForked;
  let tracked = new Map(prev.tracked);
  let edited = prev.edited;
  let unsettled = prev.unsettled;
  let awaiting = prev.awaiting;
  let unconfirmed = prev.unconfirmed;
  let draft = meta?.draft !== undefined ? meta.draft : prev.draft;
  if (draft !== prev.draft) changed = true;
  /** Threads to resolve, and what may be done with what is found. */
  const toResolve = new Map<string, Mode>();
  /** Threads to move to where their stored anchor quotes verbatim, if it does yet. */
  const toFollow = new Set<string>();
  let blocks: PmBlockText[] | null = null;
  const blocksNow = () => (blocks ??= pmBlockTexts(tr.doc));

  if (tr.docChanged) {
    const { maps, exact } = mapsOf(tr);
    // The words a new stored anchor quotes come from another client.
    if (!exact && !forked) for (const id of awaiting) toFollow.add(id);
    if (draft) {
      const mapped = mapRange(draft, maps);
      if (mapped !== draft) changed = true;
      draft = mapped;
    }
    // The agent's own writes into its fork. A range the proposal rewrote any of
    // has nowhere honest to be until the answer lands, however much of it the
    // steps happen to keep; the person's own typing in the fork maps as ever.
    const proposal = forked && isReviewWriting();
    for (const [id, entry] of tracked) {
      if (!entry.range) continue;
      let range = mapRange(entry.range, maps);
      if (range && proposal && touches(entry.range, maps)) range = null;
      // Checked before the unchanged-range skip: typing over a letter keeps
      // both ends where they were and still rewrites the quotation.
      const edit = !forked && exact && range !== null && touches(entry.range, maps);
      if (edit && !edited.has(id)) edited = new Set(edited).add(id);
      if (range === entry.range) continue;
      changed = true;
      tracked.set(id, { ...entry, range });
      // The fork's text is a proposal: a range it took away waits for the answer.
      if (forked) continue;
      // Mid-edit, a match elsewhere may be a phrase's twin while the phrase
      // itself is on the clipboard: shown, but written only once edits pause.
      if (!range || (!exact && straddles(entry.range, maps))) {
        toResolve.set(id, "display");
        if (!unsettled.has(id)) unsettled = new Set(unsettled).add(id);
      }
    }
    // The words a held answer was missing may be what just arrived. Only
    // another client's change counts: an undo or a fork swap replaces the
    // whole document too, and brings nothing this replica lacked.
    if (!forked && isRemote(tr)) for (const id of unconfirmed.keys()) if (!edited.has(id)) toResolve.set(id, "tick");
  }

  if (meta?.threads) {
    changed = true;
    const next = new Map<string, Tracked>();
    for (const thread of meta.threads) {
      const known = tracked.get(thread.id);
      next.set(thread.id, { thread, range: known?.range ?? null });
      // Known threads keep the range their mapping has. One without a range is
      // tried again if its anchor moved: another client may have re-homed it.
      if (!known || (!known.range && !sameAnchor(known.thread, thread))) {
        toResolve.set(thread.id, "probe");
      } else if (!forked && known.range && !sameAnchor(known.thread, thread)) {
        toFollow.add(thread.id);
      }
    }
    tracked = next;
    if ([...unconfirmed.keys()].some((id) => !tracked.has(id))) {
      const kept = new Map([...unconfirmed].filter(([id]) => tracked.has(id)));
      unconfirmed = kept.size ? kept : NO_UNCONFIRMED;
    }
  }

  let resolves = prev.resolves;
  if (toFollow.size) {
    const waiting = new Set([...awaiting].filter((id) => !toFollow.has(id)));
    for (const id of toFollow) {
      const entry = tracked.get(id);
      // Mid-edit, this client's own settle pass will write the words it has.
      if (!entry?.range || toResolve.has(id) || edited.has(id) || unsettled.has(id)) continue;
      if (quotes(entry, blocksNow())) continue;
      // Verbatim only: the writer already chose the words; fuzzy or re-homed
      // guesses here would be this replica's own, and differ.
      const check = validateAnchor(entry.thread.anchor, blocksNow());
      const range = check.ok ? pmRange(blocksNow(), entry.thread.anchor.blockId, check.from, check.to) : null;
      if (range && range.to > range.from) {
        tracked.set(id, { ...entry, range });
        changed = true;
      } else waiting.add(id);
    }
    if (waiting.size !== awaiting.size || [...waiting].some((id) => !awaiting.has(id))) {
      awaiting = waiting.size ? waiting : NONE;
    }
  }

  const settling = meta?.settle === true && !forked;
  if (settling || (meta?.resolve === "all" && !forked)) {
    for (const [id, entry] of tracked) {
      // Words typed here are this client's to settle, whatever it held.
      if (unconfirmed.has(id) && edited.has(id)) continue;
      if (unconfirmed.has(id)) toResolve.set(id, "confirm");
      else if (meta?.resolve === "all" || !entry.range || unsettled.has(id)) toResolve.set(id, "persist");
    }
    unsettled = NONE;
    if (meta?.resolve === "all") awaiting = NONE;
    if ([...edited].some((id) => unconfirmed.has(id))) {
      const kept = new Map([...unconfirmed].filter(([id]) => !edited.has(id)));
      unconfirmed = kept.size ? kept : NO_UNCONFIRMED;
    }
  }

  const found = new Map<string, ResolutionWrite>();
  if (toResolve.size) {
    changed = true;
    let held: Map<string, Unconfirmed> | null = null;
    const hold = () => (held ??= new Map(unconfirmed));
    for (const [id, mode] of toResolve) {
      const entry = tracked.get(id);
      if (!entry) continue;
      resolves++;
      const resolution = resolveAnchor(entry.thread, blocksNow());
      const range =
        resolution.kind === "anchored"
          ? pmRange(blocksNow(), resolution.blockId, resolution.from, resolution.to)
          : null;
      tracked.set(id, { ...entry, range: range && range.to > range.from ? range : null });
      const writes = hasWrites(resolution.writes) ? JSON.stringify(resolution.writes) : null;
      if (mode === "persist") {
        if (!forked && writes) found.set(id, resolution.writes);
      } else if (mode === "probe" || mode === "tick" || mode === "confirm") {
        const before = unconfirmed.get(id);
        const confirmed = mode === "confirm" && before?.ticked && before.writes === writes;
        if (confirmed && writes) found.set(id, resolution.writes);
        // A fork's text proves nothing either way, so its first sight waits for the shared page.
        const pending = writes ?? (mode === "probe" && forked ? "" : null);
        if (confirmed || pending === null) {
          if (before) hold().delete(id);
        } else if (before?.writes !== pending || before.ticked !== (mode === "tick")) {
          hold().set(id, { writes: pending, ticked: mode === "tick" });
        }
      }
    }
    if (held) unconfirmed = (held as Map<string, Unconfirmed>).size ? held : NO_UNCONFIRMED;
  }
  if (settling && edited.size) {
    for (const id of edited) {
      const entry = tracked.get(id);
      const write = entry && !toResolve.has(id) ? refreshed(entry, blocksNow()) : null;
      if (write) found.set(id, write);
    }
    edited = NONE;
  }
  const writes = found.size ? found : NO_WRITES;

  // The focus follows the caret into and out of highlights — a click is a
  // caret move — until something names a thread outright.
  let active = prev.active;
  if (meta?.active !== undefined) active = meta.active;
  else if (caretMoved(tr)) active = threadAt(tracked, tr.selection.head);
  if (active !== null && !tracked.has(active)) active = null;
  if (active !== prev.active) changed = true;

  if (
    !changed &&
    edited === prev.edited &&
    unsettled === prev.unsettled &&
    awaiting === prev.awaiting &&
    unconfirmed === prev.unconfirmed &&
    resolves === prev.resolves &&
    writes === NO_WRITES
  )
    return prev;
  return {
    tracked,
    active,
    draft,
    isForked,
    decorations: changed ? decorationsFor(tr.doc, tracked, active, draft) : prev.decorations,
    writes,
    edited,
    unsettled,
    awaiting,
    unconfirmed,
    resolves,
  };
}

/** The open thread under `pos`, the narrowest when highlights nest. */
function threadAt(tracked: ReadonlyMap<string, Tracked>, pos: number): string | null {
  let best: string | null = null;
  let span = Infinity;
  for (const [id, { thread, range }] of tracked) {
    if (!range || thread.status !== "open" || pos < range.from || pos > range.to) continue;
    if (range.to - range.from < span) {
      best = id;
      span = range.to - range.from;
    }
  }
  return best;
}

// ---- Listeners ----------------------------------------------------------------

type Hub = {
  listeners: Set<(state: EditorState) => void>;
  persist: ((writes: ReadonlyMap<string, ResolutionWrite>) => void) | null;
};

const hubs = new WeakMap<EditorView, Hub>();

function hubFor(view: EditorView): Hub {
  let hub = hubs.get(view);
  if (!hub) {
    hub = { listeners: new Set(), persist: null };
    hubs.set(view, hub);
  }
  return hub;
}

export function commentDecorationsPlugin(): Plugin<CommentsState> {
  return new Plugin<CommentsState>({
    key: commentKey,
    state: {
      init: () => ({
        tracked: new Map(),
        active: null,
        draft: null,
        isForked: notForked,
        decorations: DecorationSet.empty,
        writes: NO_WRITES,
        edited: NONE,
        unsettled: NONE,
        awaiting: NONE,
        unconfirmed: NO_UNCONFIRMED,
        resolves: 0,
      }),
      apply,
    },
    props: {
      decorations: (state) => commentKey.getState(state)?.decorations ?? null,
      // A reader's editor has no caret to follow, so their click names the
      // thread itself. An editor's click is left alone: a transaction here
      // would redraw the paragraph and put back the caret from before it.
      handleClick(view, pos) {
        const state = commentKey.getState(view.state);
        if (!state || view.editable) return false;
        const hit = threadAt(state.tracked, pos);
        if (hit !== state.active) view.dispatch(view.state.tr.setMeta(commentKey, { active: hit } satisfies Meta));
        return false;
      },
    },
    view(editorView) {
      let settle: ReturnType<typeof setTimeout> | null = null;
      return {
        update(view, prevState) {
          const state = commentKey.getState(view.state);
          const before = commentKey.getState(prevState);
          if (!state) return;
          if (state !== before) {
            const hub = hubs.get(view);
            if (state.writes !== before?.writes && state.writes.size) hub?.persist?.(state.writes);
            if (hub) for (const listener of hub.listeners) listener(view.state);
          }
          // Any edit can bring back the words a thread without a range lost —
          // an undo, a paste — even one that moved no range.
          if (view.state.doc === prevState.doc) return;
          if (settle !== null) clearTimeout(settle);
          settle = null;
          const pending =
            state.edited.size > 0 ||
            state.unsettled.size > 0 ||
            state.unconfirmed.size > 0 ||
            [...state.tracked.values()].some((entry) => !entry.range);
          if (!pending) return;
          settle = setTimeout(() => {
            settle = null;
            if (!editorView.isDestroyed) {
              editorView.dispatch(editorView.state.tr.setMeta(commentKey, { settle: true } satisfies Meta));
            }
          }, SETTLE_MS);
        },
        destroy() {
          if (settle !== null) clearTimeout(settle);
        },
      };
    },
  });
}

// ---- The API ------------------------------------------------------------------

function send(view: EditorView, meta: Meta) {
  if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(commentKey, meta));
}

/** The page's threads, as the comments document has them now. */
export function setCommentThreads(view: EditorView, threads: readonly Thread[]) {
  const state = commentKey.getState(view.state);
  if (!state) return;
  if (threads.length === state.tracked.size && threads.every((t) => state.tracked.get(t.id)?.thread === t)) return;
  send(view, { threads });
}

/** Whether the editor is showing a review's fork; asked on every transaction. */
export function setForkProbe(view: EditorView, isForked: () => boolean) {
  send(view, { isForked });
}

/** Resolve every thread's selector again, against the document as it stands. */
export function reresolveComments(view: EditorView) {
  send(view, { resolve: "all" });
}

/** Make `threadId` the focused thread, or clear the focus with null. */
export function setActiveThread(view: EditorView, threadId: string | null) {
  const state = commentKey.getState(view.state);
  if (state && state.active !== threadId) send(view, { active: threadId });
}

/** Every known thread's live range; null for one resolving nowhere right now. */
export function commentRanges(state: EditorState): Map<string, CommentRange | null> {
  const out = new Map<string, CommentRange | null>();
  for (const [id, { range }] of commentKey.getState(state)?.tracked ?? []) out.set(id, range);
  return out;
}

export function activeThread(state: EditorState): string | null {
  return commentKey.getState(state)?.active ?? null;
}

/** Highlight `range` as the words a comment is being written about; null clears it. */
export function setCommentDraft(view: EditorView, range: CommentRange | null) {
  const state = commentKey.getState(view.state);
  if (state && (state.draft?.from !== range?.from || state.draft?.to !== range?.to)) send(view, { draft: range });
}

/** The draft's live range, or null once its words are gone or there is none. */
export function commentDraft(state: EditorState): CommentRange | null {
  return commentKey.getState(state)?.draft ?? null;
}

/** Selector resolutions this editor has run — how a test proves typing ran none. */
export function commentResolveCount(state: EditorState): number {
  return commentKey.getState(state)?.resolves ?? 0;
}

/**
 * Calls `listener` once after each transaction that moved a range or the
 * draft, changed the set of threads or the focused one — never once per thread.
 */
export function subscribeComments(view: EditorView, listener: (state: EditorState) => void): () => void {
  const { listeners } = hubFor(view);
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Where the writes go: at most one per thread per transaction. One persister
 * per editor; the last to connect wins, and disconnecting clears it.
 */
export function persistCommentWrites(
  view: EditorView,
  persist: (writes: ReadonlyMap<string, ResolutionWrite>) => void,
): () => void {
  const hub = hubFor(view);
  hub.persist = persist;
  return () => {
    if (hub.persist === persist) hub.persist = null;
  };
}
