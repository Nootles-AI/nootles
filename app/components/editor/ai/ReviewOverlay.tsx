"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getBlocksChangedByTransaction } from "@blocknote/core";
import type { Transaction } from "prosemirror-state";
import type { Id } from "@/convex/_generated/dataModel";
import { useReview, useReviewTurns } from "@/app/components/ReviewContext";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { isReviewWriting } from "@/app/lib/ai/review/attribution";
import type { TurnReview } from "@/app/lib/ai/review/session";
import { setReview, type ReviewHunk, type ReviewSpec } from "./reviewDecorations";

/**
 * The face of the review pipeline: what the agent changed, drawn where it
 * changed it, and a way to say yes or no to any of it.
 *
 * The document is never locked while this is up. People read a change by
 * editing it, and a review that forbade that would be a modal dialog wearing a
 * diff. What it costs is that a block the user has since rewritten can no longer
 * be honestly reverted — so the session marks it kept, and the affordance for
 * taking it back goes away rather than lying about what it would do.
 */
export function ReviewOverlay({
  editor,
  pageId,
}: {
  editor: LiveEditor;
  pageId: Id<"pages">;
}) {
  const session = useReview();
  const turns = useReviewTurns();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(EMPTY);
  const [failure, setFailure] = useState<string | null>(null);

  const pending = useMemo(() => turns.filter((t) => t.status === "pending"), [turns]);

  const expand = useCallback((runId: string) => {
    setExpanded((prior) => new Set(prior).add(runId));
  }, []);

  const run = useCallback((work: Promise<unknown>) => {
    setFailure(null);
    void work.catch((e: Error) => setFailure(e.message));
  }, []);

  const answer = useCallback(
    (hunkId: string, verdict: "accepted" | "rejected") => {
      run(verdict === "accepted" ? session.accept(hunkId) : session.reject(hunkId));
    },
    [run, session],
  );

  const spec: ReviewSpec = useMemo(() => {
    const hunks: ReviewHunk[] = pending.flatMap((turn) => {
      const page = turn.pages.find((p) => p.pageId === pageId);
      // Without the checkpoint there is no "before", and a diff drawn against a
      // guess is worse than one drawn a moment later.
      const before = page?.before;
      if (!page || !before) return [];
      const was = new Map(descend(before).map((b) => [b.id, b]));
      return page.hunks
        .filter((hunk) => (page.status[hunk.id] ?? "pending") === "pending")
        .map(
          (hunk): ReviewHunk => ({
            id: hunk.id,
            kind: hunk.kind,
            added: hunk.added,
            changed: hunk.changed.flatMap((id) => {
              const original = was.get(id);
              return original ? [{ id, before: original }] : [];
            }),
            moved: hunk.moved,
            removed: hunk.removed,
            before,
            kept: session.isKept(turn.chatPromptId, pageId, hunk),
          }),
        );
    });
    return hunks.length ? { hunks, expanded, answer, expand } : null;
  }, [pending, pageId, session, expanded, answer, expand]);

  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    setReview(view, spec);
  }, [editor, spec]);

  // Manual edits during the review. Attribution matters more than the ids do:
  // count someone else's edit as the user's and the change becomes theirs, the
  // Discard button goes, and the only answer left is one they never gave.
  //
  // Read from the transaction rather than through `editor.onChange`, because
  // three things arrive there looking exactly like typing. The applier's own
  // writes — caught by the depth in `attribution.ts`, which only works because
  // they run synchronously inside it. Steps arriving over the wire — the second
  // tab the user keeps open, or the catch-up after a reload, both of which
  // replay the AGENT's edits into this callback; BlockNote's only remote test
  // is a Yjs one and this stack is prosemirror-collab, whose `receiveTransaction`
  // is identifiable by the `rebased` meta it sets. And Cmd-Z, which is the user
  // taking something back rather than writing it.
  useEffect(() => {
    const tiptap = editor._tiptapEditor;
    const onUpdate = ({
      transaction,
      appendedTransactions,
    }: {
      transaction: Transaction;
      appendedTransactions: Transaction[];
    }) => {
      if (isReviewWriting() || transaction.getMeta("rebased") !== undefined) return;
      const ids = getBlocksChangedByTransaction(transaction, appendedTransactions)
        .filter((change) => change.type !== "delete" && !HISTORY.has(change.source.type))
        .map((change) => change.block.id as string);
      session.userEdited(pageId, ids);
    };
    tiptap.on("update", onUpdate);
    return () => void tiptap.off("update", onUpdate);
  }, [editor, session, pageId]);

  const turn = pending[pending.length - 1];
  if (!turn) return null;
  return (
    <ReviewBar
      turn={turn}
      others={pending.length - 1}
      failure={failure}
      onKeep={() => run(session.acceptAll(turn.chatPromptId))}
      onDiscard={() => run(session.rejectAll(turn.chatPromptId))}
      onRevert={() => run(session.revertTurn(turn.chatPromptId))}
    />
  );
}

/**
 * One bar for the whole turn, at the foot of the window rather than beside the
 * text — it is a control for the SET of changes, the same distinction the
 * reformat switcher draws, and it stays neutral for the same reason: the colour
 * on this screen belongs to the diff.
 */
function ReviewBar({
  turn,
  others,
  failure,
  onKeep,
  onDiscard,
  onRevert,
}: {
  turn: TurnReview;
  others: number;
  failure: string | null;
  onKeep: () => void;
  onDiscard: () => void;
  onRevert: () => void;
}) {
  const open = turn.pages.flatMap((page) =>
    page.hunks.filter((h) => (page.status[h.id] ?? "pending") === "pending"),
  );
  const pages = turn.pages.filter((page) =>
    page.hunks.some((h) => (page.status[h.id] ?? "pending") === "pending"),
  ).length;

  return (
    <div className="ab-review-bar" style={{ zIndex: "var(--z-sticky)" }} role="status">
      <span className="ab-review-count">
        {open.length} change{open.length === 1 ? "" : "s"}
        {pages > 1 ? ` · ${pages} pages` : ""}
        {others ? ` · ${others} earlier` : ""}
      </span>
      <span className="ab-review-sep" aria-hidden />
      <button className="ab-review-action" onClick={onKeep}>
        Keep all
      </button>
      <button className="ab-review-action" onClick={onDiscard}>
        Discard all
      </button>
      <button
        className="ab-review-action is-quiet"
        onClick={onRevert}
        title="Put the page back exactly as it was, including anything you have typed since"
      >
        Revert
      </button>
      {failure && <span className="ab-review-failure">{failure}</span>}
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();
/** Change sources that are the user taking an edit back rather than making one. */
const HISTORY: ReadonlySet<string> = new Set(["undo", "redo", "undo-redo"]);

type Nested = { id: string; children?: Nested[] };

function descend<T extends Nested>(blocks: T[]): T[] {
  return blocks.flatMap((b) => [b, ...descend((b.children ?? []) as T[])]);
}
