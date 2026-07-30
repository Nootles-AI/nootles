"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import type { Batch, Operation } from "@/convex/ai/operations";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { applyBatch, type OpTrace } from "../apply";
import type { AnyBlock } from "../projection";
import { AI } from "../aiConfig";
import { asReview } from "./attribution";
import { computeHunks, type Hunk } from "./hunks";
import { canonicalise, produces, target } from "./ops";
import { planReplay } from "./replay";
import { restoreDocument, undoHunks } from "./undo";

/**
 * The apply-with-review pipeline.
 *
 * An agent edit is applied FOR REAL — the user judges the document, not a
 * rendering of one — and what the applier did is kept so that saying no is
 * deterministic rather than approximate. Accepting therefore touches nothing: it
 * settles a hunk and lets the decorations go. Only rejecting writes, and it
 * writes only where the hunk did (see `undo.ts`), because a review outlives its
 * turn and the page will have moved on.
 *
 * A checkpoint is per page, taken on the first edit of that page in the turn.
 * Three pages is three checkpoints, because `applyBatch` commits per call and a
 * turn spanning pages was never atomic to begin with.
 */

export type HunkStatus = "pending" | "accepted" | "rejected";
export type TurnStatus = Doc<"chatTurns">["status"];

export type PageReview = {
  pageId: Id<"pages">;
  checkpointId: Id<"checkpoints">;
  /** Canonical ops — every `tempId` is the id it produced. */
  ops: Operation[];
  trace: OpTrace[];
  hunks: Hunk[];
  status: Record<string, HunkStatus>;
  /**
   * Blocks each edit declared it was consuming, for `computeHunks` — one entry
   * per call, never merged: a second edit_page must not widen the first one's
   * hunk by standing next to it.
   */
  replacing: string[][];
  /** Whether the kept ops have reached the op log; they go once, on settling. */
  logged?: boolean;
  /** The checkpoint document, kept while we have it rather than re-fetched. */
  before?: AnyBlock[];
};

export type TurnReview = {
  threadId: Id<"chatThreads">;
  projectId: Id<"projects">;
  chatPromptId: string;
  status: TurnStatus;
  pages: PageReview[];
};

/** Where a page stood before a rewind was previewed, so Cancel can return to it. */
export type ReturnPoint = {
  pageId: Id<"pages">;
  checkpointId: Id<"checkpoints">;
};

export type StageResult = {
  added: number;
  removed: number;
  changed: number;
  hunks: number;
};

type Deps = {
  convex: ConvexReactClient;
  /** A page can only be undone through its editor, and only the open page has one. */
  openPage: (pageId: Id<"pages">) => void;
  editorFor: (pageId: Id<"pages">) => Promise<LiveEditor>;
};

export class ReviewSession {
  private listeners = new Set<() => void>();
  private turns: TurnReview[] = [];
  private running: Omit<TurnReview, "status" | "pages"> | null = null;
  /** The turn the loop is still writing, as opposed to the one it wrote last. */
  private writing: string | null = null;
  /**
   * Why the last answer could not be given.
   *
   * Here rather than in the bar that shows it because the two places an answer
   * comes from are in different parts of the tree — the per-hunk buttons are
   * drawn into the document, the whole-turn ones live above the workspace — and
   * there is one place on screen to report either of them failing.
   */
  private failure: string | null = null;
  /**
   * Blocks the user has rewritten by hand since a turn staged them, per turn and
   * page. Deliberately outside `TurnReview`: it is written on keystrokes, and
   * every path that rebuilds a turn does so across an await, so anything living
   * in there would be lost by whichever commit landed next.
   *
   * It does reach the row, on a debounce — a reload that forgot it would put the
   * Discard button back on a block the user has since made theirs, and pressing
   * it would overwrite their words with the checkpoint's.
   */
  private edited = new Map<string, Set<string>>();
  private flushing: ReturnType<typeof setTimeout> | null = null;
  /**
   * One at a time. Every path here reads the turns, awaits Convex or an editor,
   * and writes them back — so two overlapping calls both derive from the state
   * before either ran, and the second commit erases the first. Two adjacent
   * buttons make that a one-double-click bug.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private deps: Deps) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly TurnReview[] => this.turns;

  getFailure = (): string | null => this.failure;

  /** Gives an answer, and holds on to why if it could not be given. */
  answer(work: Promise<unknown>) {
    this.setFailure(null);
    void work.catch((e: Error) => this.setFailure(e.message));
  }

  /** The turn edits will stage into. Nothing is written until one arrives. */
  beginTurn(turn: { threadId: Id<"chatThreads">; projectId: Id<"projects">; chatPromptId: string }) {
    const previous = this.running;
    this.running = turn;
    this.writing = turn.chatPromptId;
    // A second net under `endTurn`, which fires from an effect in the chat
    // panel and therefore does not fire at all if that panel unmounts or the
    // tab closes mid-turn. A turn left "streaming" is a turn with changes on
    // the page and no bar offering them, so the arrival of the next question —
    // proof the last one is over — settles it.
    if (previous && previous.chatPromptId !== turn.chatPromptId) {
      void this.endTurn(previous.chatPromptId);
    }
    this.emit([...this.turns]);
  }

  /**
   * Whether the loop is still going.
   *
   * Not the same question as `running`, which stays pointed at the last turn on
   * purpose so a tool call arriving a beat late still has somewhere to stage.
   * Answering both from one field is what kept the review bar hidden until the
   * NEXT question was asked.
   */
  isWriting(chatPromptId: string): boolean {
    return this.writing === chatPromptId;
  }

  /**
   * Whether this turn has changes on the page that nobody has answered.
   *
   * A row says "streaming" until `endTurn` says otherwise, and that is a
   * liveness claim made by a React effect — trusted literally it hides the
   * review bar for good. This session knows which turn it is actually writing,
   * so anything else has finished whatever its row still says.
   */
  isOpen(turn: TurnReview): boolean {
    return (
      (turn.status === "pending" || turn.status === "streaming") &&
      turn.pages.some((p) =>
        p.hunks.some((h) => (p.status[h.id] ?? "pending") === "pending"),
      )
    );
  }

  /**
   * Idempotent: a turn is ended by finishing, by Stop, and by switching thread.
   * The running turn is deliberately not forgotten here — only `beginTurn`
   * replaces it — so a tool call that arrives a beat late has somewhere to go
   * instead of failing.
   */
  endTurn(chatPromptId: string) {
    // Outside the queue, and first: this is what puts the bar on screen, and
    // making it wait behind whatever Convex writes are in flight is the
    // difference between answering immediately and answering a second later.
    if (this.writing === chatPromptId) {
      this.writing = null;
      this.emit([...this.turns]);
    }
    return this.enqueue(async () => {
      const turn = this.find(chatPromptId);
      if (!turn || turn.status !== "streaming") return;
      await this.commit({ ...turn, status: statusOf({ ...turn, status: "pending" }) });
    });
  }

  /**
   * Checkpoint, apply, record, offer up for review.
   *
   * The batch must already have passed `resolveBatch`; validation belongs to the
   * caller because a rejected batch is a message back to the model, not a
   * failure of the pipeline.
   */
  stage(args: {
    pageId: Id<"pages">;
    editor: LiveEditor;
    batch: Batch;
    /** Blocks the edit declared it was consuming, as `edit_page` was told them. */
    replacing?: string[];
  }): Promise<StageResult> {
    return this.enqueue(() => this.runStage(args));
  }

  /** Settles a hunk and leaves the document exactly as it is. */
  accept(hunkId: string) {
    return this.settle(hunkId, "accepted");
  }

  reject(hunkId: string) {
    return this.settle(hunkId, "rejected");
  }

  acceptAll(chatPromptId?: string) {
    return this.settleAll("accepted", chatPromptId);
  }

  rejectAll(chatPromptId?: string) {
    return this.settleAll("rejected", chatPromptId);
  }

  /**
   * Puts a page back exactly as the checkpoint had it, manual edits and all.
   *
   * The blunt instrument, and the only honest way to say "none of this": undoing
   * hunk by hunk leaves whatever the user typed into the change, which is
   * usually what they want and sometimes precisely not.
   */
  revertTurn(chatPromptId: string) {
    return this.enqueue(async () => {
      const turn = this.find(chatPromptId);
      if (!turn || this.isWriting(chatPromptId)) return;
      for (const { pageId } of turn.pages) {
        const current = this.find(chatPromptId);
        const page = current?.pages.find((p) => p.pageId === pageId);
        if (!current || !page) continue;
        const before = page.before ?? (await this.checkpointDoc(page.checkpointId));
        if (!before) continue;
        this.deps.openPage(pageId);
        const editor = await this.deps.editorFor(pageId).catch(() => null);
        if (!editor) {
          throw new Error("That page did not finish loading, so the change was left as it is.");
        }
        restoreDocument(editor, before);
        this.edited.delete(key(chatPromptId, pageId));
        const status = Object.fromEntries(
          page.hunks.map((h) => [h.id, "rejected" as HunkStatus]),
        );
        await this.commit(this.turnWith(current, { ...page, before, status }));
      }
    });
  }

  /**
   * Puts every page a turn touched back to the checkpoint it was taken from,
   * whatever the user has since said about it.
   *
   * The rewind, as opposed to the review. `revertTurn` only speaks for a turn
   * still being decided; this one answers "put it back the way it was before I
   * asked", which has to keep working after the change was kept — otherwise
   * accepting is irreversible, and nobody accepts freely under that.
   *
   * The row is fetched rather than read from memory: a settled turn is not in
   * the unreviewed set, which is the only thing this session holds.
   */
  restoreCheckpoint(chatPromptId: string) {
    return this.enqueue(async () => {
      await this.runRestore(chatPromptId);
      await this.runSettleRestore(chatPromptId);
    });
  }

  /**
   * The same rewind, shown rather than done.
   *
   * Rolls the pages back and hands back the way forward again, so the change
   * can be looked at before it is agreed to. The document really moves —
   * judging a rendering of a rewind is judging the wrong thing — and what makes
   * that safe is that where it came from is checkpointed first.
   *
   * Only the pages. The conversation is not truncated until the rewind is
   * confirmed, so a preview left open by a closed tab settles as "notes rolled
   * back, conversation intact", which is a state the UI already offers by name.
   */
  previewRestore(chatPromptId: string): Promise<ReturnPoint[]> {
    return this.enqueue(() => this.runRestore(chatPromptId));
  }

  /** Puts back what `previewRestore` rolled away from. */
  cancelRestore(points: readonly ReturnPoint[]) {
    return this.enqueue(async () => {
      for (const { pageId, checkpointId } of points) {
        const forward = await this.checkpointDoc(checkpointId);
        if (!forward) continue;
        await this.writePage(pageId, forward);
      }
    });
  }

  /** Records that the turn was undone, once the rewind has been confirmed. */
  settleRestore(chatPromptId: string) {
    return this.enqueue(() => this.runSettleRestore(chatPromptId));
  }

  private async runRestore(chatPromptId: string): Promise<ReturnPoint[]> {
    const row = await this.deps.convex.query(api.chat.turns.byPrompt, {
      chatPromptId,
    });
    if (!row) return [];

    // From the trace, where the page and the checkpoint it was taken from are
    // written down together — the two id arrays on the row are parallel by
    // construction, which is a thing to rely on only when there is no
    // alternative.
    const pages = ((row.trace ?? {}) as StoredTrace).pages ?? [];
    const points: ReturnPoint[] = [];
    for (const { pageId, checkpointId } of pages) {
      const before = await this.checkpointDoc(checkpointId);
      if (!before) continue;
      const editor = await this.editorOn(pageId);
      points.push({
        pageId,
        checkpointId: await this.deps.convex.mutation(api.ai.checkpoints.create, {
          pageId,
          chatPromptId: `rewind:${chatPromptId}`,
          docSnapshot: convexSafe(editor.document as unknown as AnyBlock[]),
        }),
      });
      restoreDocument(editor, before);
      this.edited.delete(key(chatPromptId, pageId));
    }
    return points;
  }

  private async runSettleRestore(chatPromptId: string) {
    // The turn is answered by being undone, and a turn still awaiting review
    // must leave the unreviewed set or its diff outlives the change.
    const live = this.find(chatPromptId);
    if (live) {
      await this.commit({ ...live, status: "rejected" });
      return;
    }
    const row = await this.deps.convex.query(api.chat.turns.byPrompt, {
      chatPromptId,
    });
    if (!row) return;
    await this.deps.convex.mutation(api.chat.turns.save, {
      threadId: row.threadId,
      projectId: row.projectId,
      chatPromptId,
      pageIds: row.pageIds,
      checkpointIds: row.checkpointIds,
      trace: row.trace,
      hunks: row.hunks,
      status: "rejected",
    });
  }

  private async writePage(pageId: Id<"pages">, blocks: AnyBlock[]) {
    restoreDocument(await this.editorOn(pageId), blocks);
  }

  /** The live editor for a page, opened first because only the open page has one. */
  private async editorOn(pageId: Id<"pages">): Promise<LiveEditor> {
    this.deps.openPage(pageId);
    const editor = await this.deps.editorFor(pageId).catch(() => null);
    if (!editor) {
      throw new Error("That page did not finish loading, so it was left as it is.");
    }
    return editor;
  }

  /**
   * Blocks the user just rewrote by hand. A change they have since edited is
   * theirs, and the review stops offering to take it back — undoing it would
   * throw away work nobody asked to lose.
   */
  userEdited(pageId: Id<"pages">, blockIds: readonly string[]) {
    if (!blockIds.length) return;
    const dirty: TurnReview[] = [];
    for (const turn of this.turns) {
      if (turn.status !== "pending" && turn.status !== "streaming") continue;
      const page = turn.pages.find((p) => p.pageId === pageId);
      if (!page) continue;
      const open = new Set(
        page.hunks
          .filter((h) => (page.status[h.id] ?? "pending") === "pending")
          .flatMap((h) => [...h.added, ...h.changed, ...h.moved]),
      );
      const mine = blockIds.filter((id) => open.has(id));
      if (!mine.length) continue;
      const k = key(turn.chatPromptId, pageId);
      const set = this.edited.get(k) ?? new Set<string>();
      const before = set.size;
      for (const id of mine) set.add(id);
      this.edited.set(k, set);
      if (set.size !== before) dirty.push(turn);
    }
    if (!dirty.length) return;
    // A new array so `useSyncExternalStore` sees the change; the turns
    // themselves are untouched, and the answer lives beside them.
    this.emit([...this.turns]);
    this.scheduleFlush(dirty);
  }

  /** Blocks of this turn's change that the user has since rewritten. */
  editedIn(chatPromptId: string, pageId: Id<"pages">): ReadonlySet<string> {
    return this.edited.get(key(chatPromptId, pageId)) ?? EMPTY;
  }

  /**
   * Whether a hunk is now the user's, and so cannot honestly be discarded.
   * Moved blocks count: discarding puts the checkpoint's subtree back, which is
   * as much a rewrite of a carried-over child as of a rewritten paragraph.
   */
  isKept(chatPromptId: string, pageId: Id<"pages">, hunk: Hunk): boolean {
    const edited = this.editedIn(chatPromptId, pageId);
    const superseded = this.supersededIn(chatPromptId, pageId);
    return [...hunk.added, ...hunk.changed, ...hunk.moved].some(
      (id) => edited.has(id) || superseded.has(id),
    );
  }

  /** Turns that were left unanswered — a reload, a closed tab. */
  hydrate(rows: Doc<"chatTurns">[]) {
    const known = new Set(this.turns.map((t) => t.chatPromptId));
    const fresh = rows.filter((r) => !known.has(r.chatPromptId));
    const restored = fresh.map(fromRow);
    if (!restored.length) return;
    for (const row of fresh) {
      for (const page of ((row.hunks ?? {}) as StoredHunks).pages ?? []) {
        if (page.edited?.length) {
          this.edited.set(key(row.chatPromptId, page.pageId), new Set(page.edited));
        }
      }
    }
    this.emit([...restored, ...this.turns]);
    // The diff is drawn against the checkpoint, and a restored turn has only the
    // id of one. Fetched rather than persisted twice: the row already points at
    // the document it was taken from.
    void this.enqueue(() => this.fillCheckpoints(restored));
  }

  // -------------------------------------------------------------------------

  /**
   * Gets the edited set into the row without writing on every keystroke. Only
   * ever late by the debounce, and what it costs being late is one block's
   * Discard button coming back after a reload.
   */
  private scheduleFlush(turns: TurnReview[]) {
    const ids = turns.map((t) => t.chatPromptId);
    if (this.flushing) clearTimeout(this.flushing);
    this.flushing = setTimeout(() => {
      this.flushing = null;
      void this.enqueue(async () => {
        for (const id of ids) {
          const turn = this.find(id);
          if (turn) await this.commit(turn);
        }
      });
    }, AI.review.editedFlushMs);
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    // A call that failed must not take the ones behind it with it.
    this.queue = result.then(noop, noop);
    return result;
  }

  private find(chatPromptId: string) {
    return this.turns.find((t) => t.chatPromptId === chatPromptId);
  }

  private emit(turns: TurnReview[]) {
    this.turns = turns;
    // A failure is about an attempt to answer something. Once nothing is open it
    // has no subject left, and the bar it would be shown in has gone — so held
    // any longer it would be sitting there waiting to reappear over the next
    // turn's changes, which it was never about.
    if (this.failure && !turns.some((turn) => this.isOpen(turn))) this.failure = null;
    this.notify();
  }

  private setFailure(message: string | null) {
    if (this.failure === message) return;
    this.failure = message;
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private async fillCheckpoints(turns: TurnReview[]) {
    const wanted = turns.filter((t) => t.status === "pending");
    const docs = await Promise.all(
      wanted.flatMap((t) =>
        t.pages
          .filter((p) => !p.before)
          .map(async (p) => [p.checkpointId, await this.checkpointDoc(p.checkpointId)] as const),
      ),
    );
    const byCheckpoint = new Map(docs);
    if (!byCheckpoint.size) return;
    this.emit(
      this.turns.map((turn) => ({
        ...turn,
        pages: turn.pages.map((page) => {
          const before = page.before ?? byCheckpoint.get(page.checkpointId);
          return before ? { ...page, before } : page;
        }),
      })),
    );
  }

  private async runStage({
    pageId,
    editor,
    batch,
    replacing,
  }: {
    pageId: Id<"pages">;
    editor: LiveEditor;
    batch: Batch;
    replacing?: string[];
  }): Promise<StageResult> {
    const running = this.running;
    if (!running) throw new Error("No turn is running");
    const { chatPromptId } = running;

    let page = this.find(chatPromptId)?.pages.find((p) => p.pageId === pageId);
    if (!page) {
      const before = convexSafe(editor.document as unknown as AnyBlock[]);
      const checkpointId = await this.deps.convex.mutation(api.ai.checkpoints.create, {
        pageId,
        chatPromptId,
        docSnapshot: before,
      });
      page = {
        pageId,
        checkpointId,
        ops: [],
        trace: [],
        hunks: [],
        status: {},
        replacing: [],
        before,
      };
    }

    const before = page.before ?? (await this.checkpointDoc(page.checkpointId));
    if (!before) throw new Error("The checkpoint for this page is gone; it cannot be edited.");

    const missing = absentRefs(editor, batch);
    if (missing.length) throw new Error(gone(missing));

    const offset = page.ops.length;
    // One transaction, and out of the history.
    //
    // Whole, because half a batch is not something anyone can review: a
    // `transact` whose callback throws is never dispatched, so a batch that dies
    // partway leaves the page exactly as it found it.
    //
    // Out of the history, because the review IS the undo affordance for an agent
    // edit. Left in, prosemirror-history would still hold the inverse of a
    // change the user has since discarded, and rebase it over the discard rather
    // than drop it — Cmd-Z would then bring the block back a second time, under
    // an id the document already has.
    const result = asReview(() =>
      editor.transact((tr) => {
        tr.setMeta("addToHistory", false);
        return applyBatch(editor, batch);
      }),
    );

    const ops = [...page.ops, ...canonicalise(batch.ops, result)];
    const trace = [
      ...page.trace,
      ...result.trace.map((t) => ({ ...t, opIndex: t.opIndex + offset })),
    ];
    const consumed = replacing?.length ? [...page.replacing, replacing] : page.replacing;
    const hunks = computeHunks({
      chatPromptId,
      pageId,
      ops,
      trace,
      before,
      replacing: consumed,
    });

    const next: PageReview = {
      ...page,
      ops,
      trace,
      hunks,
      before,
      replacing: consumed,
      status: carryAnswers(page, hunks),
    };
    await this.commit(this.withPage(running, next));

    return {
      added: hunks.reduce((n, h) => n + h.added.length, 0),
      removed: hunks.reduce((n, h) => n + h.removed.length, 0),
      changed: hunks.reduce((n, h) => n + h.changed.length, 0),
      hunks: hunks.length,
    };
  }

  /**
   * Blocks a LATER turn has since changed, for one of this turn's pages.
   *
   * Changes stack — a second question about the same paragraph is the normal
   * case, not an error — but the older change can then no longer be taken back
   * on its own: its checkpoint holds that block as its own edit found it, and
   * writing that back would undo the newer edit as well, silently.
   *
   * So it is treated exactly like a block the user retyped, which is the same
   * situation with a different author: the change stands, and the affordance to
   * discard it goes rather than lying about what it would do.
   */
  private supersededIn(chatPromptId: string, pageId: Id<"pages">): ReadonlySet<string> {
    const mine = this.turns.findIndex((t) => t.chatPromptId === chatPromptId);
    if (mine < 0) return EMPTY;
    const later = new Set<string>();
    for (const turn of this.turns.slice(mine + 1)) {
      const page = turn.pages.find((p) => p.pageId === pageId);
      if (!page) continue;
      for (const hunk of page.hunks) {
        for (const id of [...hunk.added, ...hunk.changed, ...hunk.moved]) later.add(id);
      }
    }
    return later;
  }

  private withPage(
    turn: Omit<TurnReview, "status" | "pages">,
    page: PageReview,
  ): TurnReview {
    const existing = this.find(turn.chatPromptId);
    const pages = existing?.pages.some((p) => p.pageId === page.pageId)
      ? existing.pages.map((p) => (p.pageId === page.pageId ? page : p))
      : [...(existing?.pages ?? []), page];
    return { ...turn, pages, status: statusOf({ status: existing?.status ?? "streaming", pages }) };
  }

  private settle(hunkId: string, to: HunkStatus) {
    return this.enqueue(async () => {
      const turn = this.turns.find((t) =>
        t.pages.some((p) => p.status[hunkId] === "pending"),
      );
      const page = turn?.pages.find((p) => p.status[hunkId] === "pending");
      // Nothing is answerable while the turn is still writing: a hunk it is
      // still growing can be regrouped, and regrouped it has a different id.
      if (!turn || !page || this.isWriting(turn.chatPromptId)) return;
      const hunk = page.hunks.find((h) => h.id === hunkId);
      const undo =
        to === "rejected" && hunk && !this.isKept(turn.chatPromptId, page.pageId, hunk)
          ? [hunk]
          : [];
      // A hunk the user has rewritten settles as kept whichever button was
      // pressed: their text stands, and there is nothing left to take back.
      const answer: HunkStatus = undo.length || to === "accepted" ? to : "accepted";
      await this.resolvePage(turn, { ...page, status: { ...page.status, [hunkId]: answer } }, undo);
    });
  }

  private settleAll(to: HunkStatus, chatPromptId?: string) {
    return this.enqueue(async () => {
      const wanted = this.turns
        .filter(
          (t) =>
            !this.isWriting(t.chatPromptId) &&
            (!chatPromptId || t.chatPromptId === chatPromptId),
        )
        .map((t) => ({
          chatPromptId: t.chatPromptId,
          pageIds: t.pages
            .filter((p) => Object.values(p.status).includes("pending"))
            .map((p) => p.pageId),
        }));

      const failed: string[] = [];
      for (const { chatPromptId: id, pageIds } of wanted) {
        for (const pageId of pageIds) {
          // Re-read every time: each page's commit replaces the turn it is in.
          const turn = this.find(id);
          const page = turn?.pages.find((p) => p.pageId === pageId);
          if (!turn || !page) continue;
          const open = page.hunks.filter((h) => page.status[h.id] === "pending");
          const undo =
            to === "rejected"
              ? open.filter((h) => !this.isKept(id, pageId, h))
              : [];
          const kept = new Set(undo.map((h) => h.id));
          const status = {
            ...page.status,
            ...Object.fromEntries(
              open.map((h) => [h.id, to === "accepted" || kept.has(h.id) ? to : "accepted"]),
            ),
          };
          try {
            await this.resolvePage(turn, { ...page, status }, undo);
          } catch (e) {
            // One page that cannot be answered must not strand the rest.
            failed.push((e as Error).message);
          }
        }
      }
      if (failed.length) throw new Error([...new Set(failed)].join(" "));
    });
  }

  /** Brings the document in line with a page's answers, then records them. */
  private async resolvePage(turn: TurnReview, page: PageReview, rejected: Hunk[]) {
    const before = page.before ?? (await this.checkpointDoc(page.checkpointId));
    if (!before) {
      // The page went with its checkpoint — `pages.remove` takes both — so there
      // is nothing left to put back and nothing left to log against. Retire the
      // turn rather than let it ask again on every reload.
      await this.commit({ ...turn, status: "failed" });
      return;
    }

    if (rejected.length) {
      this.deps.openPage(page.pageId);
      const editor = await this.deps.editorFor(page.pageId).catch(() => null);
      if (!editor) {
        throw new Error("That page did not finish loading, so the change was left as it is.");
      }
      undoHunks(editor, rejected, before);
    }

    const settled = !page.hunks.some((h) => (page.status[h.id] ?? "pending") === "pending");
    // Logged on settle, not on apply: the op log is the record of what the page
    // says, and an edit that was undone never said anything. Once, however many
    // times the page is answered — a later settle would append the same ops again.
    const log = settled && !page.logged;
    if (log) {
      const keep = new Set(
        page.hunks.filter((h) => page.status[h.id] !== "rejected").map((h) => h.id),
      );
      const ops = planReplay({ ops: page.ops, trace: page.trace, hunks: page.hunks, keep, before });
      if (ops.length) {
        await this.deps.convex.mutation(api.ai.opLog.appendBatch, {
          pageId: page.pageId,
          chatPromptId: turn.chatPromptId,
          source: "ai",
          ops,
        });
      }
    }

    await this.commit(this.turnWith(turn, { ...page, before, logged: page.logged || log }));
  }

  private turnWith(turn: TurnReview, page: PageReview): TurnReview {
    const pages = turn.pages.map((p) => (p.pageId === page.pageId ? page : p));
    return { ...turn, pages, status: statusOf({ ...turn, pages }) };
  }

  private async commit(turn: TurnReview) {
    const existing = this.find(turn.chatPromptId);
    if (turn.status !== "streaming" && turn.status !== "pending") {
      for (const page of turn.pages) this.edited.delete(key(turn.chatPromptId, page.pageId));
    }
    this.emit(
      existing
        ? this.turns.map((t) => (t.chatPromptId === turn.chatPromptId ? turn : t))
        : [...this.turns, turn],
    );
    await this.deps.convex.mutation(api.chat.turns.save, {
      threadId: turn.threadId,
      projectId: turn.projectId,
      chatPromptId: turn.chatPromptId,
      pageIds: turn.pages.map((p) => p.pageId),
      checkpointIds: turn.pages.map((p) => p.checkpointId),
      trace: convexSafe({
        pages: turn.pages.map(({ pageId, checkpointId, ops, trace, replacing, logged }) => ({
          pageId,
          checkpointId,
          ops,
          trace,
          replacing,
          logged,
        })),
      }),
      hunks: convexSafe({
        pages: turn.pages.map(({ pageId, hunks, status }) => ({
          pageId,
          hunks,
          status,
          edited: [...this.editedIn(turn.chatPromptId, pageId)],
        })),
      }),
      status: turn.status,
    });
  }

  private async checkpointDoc(checkpointId: Id<"checkpoints">): Promise<AnyBlock[] | null> {
    const row = await this.deps.convex.query(api.ai.checkpoints.get, { id: checkpointId });
    return (row?.docSnapshot as AnyBlock[]) ?? null;
  }
}

/**
 * Ids the batch names that the document no longer has. `resolveBatch` proved it
 * against the page the compiler read, and the review queue means time has passed
 * since — a checkpoint round trip at least. The applier throws on an id it
 * cannot find, and a batch that dies halfway is worse than one that never ran.
 */
function absentRefs(editor: LiveEditor, batch: Batch): string[] {
  const coming = new Set(batch.ops.flatMap(produces));
  const named = batch.ops.flatMap((op) => {
    const at =
      op.kind === "insertBlocks" ? op.at : op.kind === "moveBlock" ? op.to : undefined;
    const id = target(op);
    return [
      ...(id === undefined ? [] : [id]),
      ...(at && (at.at === "before" || at.at === "after") ? [at.ref] : []),
    ];
  });
  return [...new Set(named)].filter((id) => !coming.has(id) && !editor.getBlock(id));
}

function gone(ids: string[]): string {
  return [
    `That edit was not applied, and nothing on the page changed. The page no longer has ${
      ids.length === 1 ? "a block with id" : "blocks with ids"
    } ${ids.map((id) => `"${id}"`).join(", ")} — it moved on while you were writing.`,
    "Read it again and work from the ids it gives you now.",
  ].join("\n");
}

/**
 * Block JSON as Convex will take it.
 *
 * BlockNote materialises a table's `columnWidths` as `[undefined, undefined]` —
 * its way of saying "size these yourself" — and `undefined` inside an ARRAY is
 * not a Convex value, so without this a page with a table on it cannot be
 * checkpointed at all and a turn that creates one cannot be recorded. The JSON
 * round trip is the whole fix: undefined array members become null, which
 * BlockNote reads back as the same instruction.
 */
function convexSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * A turn is what its hunks say, once it has stopped writing them. Derived rather
 * than latched, so a page staged after an earlier one settled puts the turn back
 * to "pending" instead of leaving it invisible to `unreviewed` for good.
 */
function statusOf(turn: { status: TurnStatus; pages: PageReview[] }): TurnStatus {
  if (turn.status === "streaming" || turn.status === "failed") return turn.status;
  const answers = turn.pages.flatMap((p) => p.hunks.map((h) => p.status[h.id] ?? "pending"));
  if (!answers.length || answers.includes("pending")) return "pending";
  return answers.includes("accepted") ? "accepted" : "rejected";
}

/**
 * A later edit to the same page can widen a hunk, which renames it. An answer
 * already given is carried across by the ops it was given about — dropped, it
 * would leave the page holding something the user has already said no to.
 */
function carryAnswers(page: PageReview, hunks: Hunk[]): Record<string, HunkStatus> {
  const answered = new Map<number, HunkStatus>();
  for (const hunk of page.hunks) {
    const answer = page.status[hunk.id];
    if (answer && answer !== "pending") for (const i of hunk.opIndices) answered.set(i, answer);
  }
  return Object.fromEntries(
    hunks.map((hunk) => {
      const answers = new Set(hunk.opIndices.map((i) => answered.get(i) ?? "pending"));
      return [hunk.id, answers.size === 1 ? [...answers][0] : "pending"];
    }),
  );
}

type StoredPage = Pick<
  PageReview,
  "pageId" | "checkpointId" | "ops" | "trace" | "replacing" | "logged"
>;
type StoredTrace = { pages?: StoredPage[] };
type StoredHunks = {
  pages?: Array<Pick<PageReview, "pageId" | "hunks" | "status"> & { edited?: string[] }>;
};

function fromRow(row: Doc<"chatTurns">): TurnReview {
  const trace = (row.trace ?? {}) as StoredTrace;
  const hunks = (row.hunks ?? {}) as StoredHunks;
  return {
    threadId: row.threadId,
    projectId: row.projectId,
    chatPromptId: row.chatPromptId,
    // Whatever it was streaming into is gone; what is left is a page with
    // changes on it and nobody having said yes.
    status: row.status === "streaming" ? "pending" : row.status,
    pages: (trace.pages ?? []).map((p) => {
      const answers = hunks.pages?.find((h) => h.pageId === p.pageId);
      return {
        ...p,
        replacing: p.replacing ?? [],
        hunks: answers?.hunks ?? [],
        status: answers?.status ?? {},
      };
    }),
  };
}

const noop = () => {};
const EMPTY: ReadonlySet<string> = new Set();

/** A space, not a control character: a NUL in here makes the file binary to grep. */
function key(chatPromptId: string, pageId: string): string {
  return `${chatPromptId} ${pageId}`;
}
