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
 * client writes it; other replicas keep their mapped ranges and take the new
 * anchor as data. Two rules keep all of this honest:
 *
 * - **Under a review fork nothing is resolved from the fork's text.** A range
 *   the proposal rewrites any of shows as unanchored and is left there; when
 *   the fork ends, every thread is resolved again against the shared
 *   document. No write is produced while a fork stands.
 * - **A live deletion never orphans on the spot.** Cut is half of cut-and-
 *   paste, so a range deleted by an edit is re-resolved at once for display,
 *   and an orphan is only recorded by the settle pass that follows the edits
 *   by `SETTLE_MS`.
 */

export type CommentRange = { from: number; to: number };

type Tracked = { thread: Thread; range: CommentRange | null };

type CommentsState = {
  tracked: ReadonlyMap<string, Tracked>;
  active: string | null;
  isForked: () => boolean;
  decorations: DecorationSet;
  /** What this transaction asks the comments document to remember. */
  writes: ReadonlyMap<string, ResolutionWrite>;
  /** Threads whose words this editor has edited since the settle pass last ran. */
  edited: ReadonlySet<string>;
  /** Selector resolutions run so far — the count the tests hold down. */
  resolves: number;
};

type Meta = {
  threads?: readonly Thread[];
  active?: string | null;
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
const NONE_EDITED: ReadonlySet<string> = new Set();
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

function decorationsFor(doc: Node, tracked: ReadonlyMap<string, Tracked>, active: string | null) {
  const decorations: Decoration[] = [];
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

/**
 * The anchor the live range would mint now, when its words are no longer the
 * stored quotation — the edit the mapping followed, made durable. Context
 * drifting alone is not worth a write: the quotation still finds itself.
 */
function refreshed(entry: Tracked, blocks: readonly PmBlockText[]): ResolutionWrite | null {
  const { range, thread } = entry;
  if (!range) return null;
  const block = blocks.find((candidate) => candidate.start <= range.from && range.to <= candidate.end);
  if (!block) return null;
  const anchor = anchorAt(block, offsetAt(block, range.from), offsetAt(block, range.to));
  if (anchor.exact.trim() === "") return null;
  if (anchor.exact === thread.anchor.exact && anchor.blockId === thread.anchor.blockId) return null;
  const check = validateAnchor(anchor, blocks);
  const ambiguous = check.ok && check.ambiguous;
  return { anchor, ...(ambiguous !== thread.ambiguous ? { ambiguous } : {}) };
}

/**
 * Whether the person moved the caret. Remote changes and fork swaps restore
 * the caret too, and must not move the focus off a thread picked in the panel.
 */
const caretMoved = (tr: Transaction) => tr.selectionSet && tr.getMeta(ySyncPluginKey) === undefined;

function apply(tr: Transaction, prev: CommentsState): CommentsState {
  const meta = tr.getMeta(commentKey) as Meta | undefined;
  if (!meta && (!prev.tracked.size || (!tr.docChanged && !caretMoved(tr)))) return prev;

  const isForked = meta?.isForked ?? prev.isForked;
  const forked = isForked();
  let changed = isForked !== prev.isForked;
  let tracked = new Map(prev.tracked);
  let edited = prev.edited;
  /** Threads to resolve, and whether an orphan found now may be recorded. */
  const toResolve = new Map<string, { mayOrphan: boolean }>();

  if (tr.docChanged) {
    const { maps, exact } = mapsOf(tr);
    // The agent's own writes into its fork. A range the proposal rewrote any of
    // has nowhere honest to be until the answer lands, however much of it the
    // steps happen to keep; the person's own typing in the fork maps as ever.
    const proposal = forked && isReviewWriting();
    for (const [id, entry] of tracked) {
      if (!entry.range) continue;
      let range = mapRange(entry.range, maps);
      if (range && proposal && touches(entry.range, maps)) range = null;
      if (range === entry.range) continue;
      changed = true;
      tracked.set(id, { ...entry, range });
      // The fork's text is a proposal: a range it took away waits for the answer.
      if (forked) continue;
      if (!range || (!exact && straddles(entry.range, maps))) {
        toResolve.set(id, { mayOrphan: false });
      } else if (exact && !edited.has(id) && touches(entry.range, maps)) {
        edited = new Set(edited).add(id);
      }
    }
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
        toResolve.set(thread.id, { mayOrphan: true });
      }
    }
    tracked = next;
  }

  const settling = meta?.settle === true && !forked;
  if (settling || (meta?.resolve === "all" && !forked)) {
    for (const [id, entry] of tracked) {
      if (meta?.resolve === "all" || !entry.range) toResolve.set(id, { mayOrphan: true });
    }
  }

  let resolves = prev.resolves;
  const found = new Map<string, ResolutionWrite>();
  let blocks: PmBlockText[] | null = null;
  if (toResolve.size) {
    changed = true;
    blocks = pmBlockTexts(tr.doc);
    for (const [id, { mayOrphan }] of toResolve) {
      const entry = tracked.get(id);
      if (!entry) continue;
      resolves++;
      const resolution = resolveAnchor(entry.thread, blocks);
      const range =
        resolution.kind === "anchored"
          ? pmRange(blocks, resolution.blockId, resolution.from, resolution.to)
          : null;
      tracked.set(id, { ...entry, range: range && range.to > range.from ? range : null });
      if (forked || !hasWrites(resolution.writes)) continue;
      if (resolution.kind === "orphaned" && !mayOrphan) continue;
      found.set(id, resolution.writes);
    }
  }
  if (settling && edited.size) {
    blocks ??= pmBlockTexts(tr.doc);
    for (const id of edited) {
      const entry = tracked.get(id);
      const write = entry && !toResolve.has(id) ? refreshed(entry, blocks) : null;
      if (write) found.set(id, write);
    }
    edited = NONE_EDITED;
  }
  const writes = found.size ? found : NO_WRITES;

  // The focus follows the caret into and out of highlights — a click is a
  // caret move — until something names a thread outright.
  let active = prev.active;
  if (meta?.active !== undefined) active = meta.active;
  else if (caretMoved(tr)) active = threadAt(tracked, tr.selection.head);
  if (active !== null && !tracked.has(active)) active = null;
  if (active !== prev.active) changed = true;

  if (!changed && edited === prev.edited && writes === NO_WRITES) return prev;
  return {
    tracked,
    active,
    isForked,
    decorations: changed ? decorationsFor(tr.doc, tracked, active) : prev.decorations,
    writes,
    edited,
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
        isForked: notForked,
        decorations: DecorationSet.empty,
        writes: NO_WRITES,
        edited: NONE_EDITED,
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
          const pending = state.edited.size > 0 || [...state.tracked.values()].some((entry) => !entry.range);
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

/** Selector resolutions this editor has run — how a test proves typing ran none. */
export function commentResolveCount(state: EditorState): number {
  return commentKey.getState(state)?.resolves ?? 0;
}

/**
 * Calls `listener` once after each transaction that moved a range, changed the
 * set of threads or the focused one — never once per thread.
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
