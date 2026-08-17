"use client";

import { useCallback, useEffect, useMemo } from "react";
import { getBlocksChangedByTransaction } from "@blocknote/core";
import type { Transaction } from "prosemirror-state";
import type { Id } from "@/convex/_generated/dataModel";
import { useOpenReviews, useReview } from "@/app/components/ReviewContext";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { isReviewWriting } from "@/app/lib/ai/review/attribution";
import { setReview, type ReviewHunk, type ReviewSpec } from "./reviewDecorations";

/**
 * The review as this page shows it: what the agent changed, drawn where it
 * changed it, and a way to say yes or no to any of it. The whole-turn answer
 * lives in `ReviewBar`, which outlives this page.
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
  const pending = useOpenReviews();

  // A remounted editor may have outlived the fork its review was staged in
  // (Yjs keeps unanswered agent edits local to the editor that staged them) —
  // put the staged content back before the decorations try to point at it.
  useEffect(() => {
    void session.restageOnOpen(pageId);
  }, [session, pageId, editor]);

  const answer = useCallback(
    (hunkId: string, verdict: "accepted" | "rejected") => {
      session.answer(
        verdict === "accepted" ? session.accept(hunkId) : session.reject(hunkId),
      );
    },
    [session],
  );

  // Drawn once the set can be answered, not while it is still growing. A hunk
  // the agent is still adding to gets regrouped, and regrouped it has a new id
  // — so its buttons would settle nothing, and a control that does nothing is
  // worse than one that is not there yet. The bar carries the count meanwhile.
  const spec: ReviewSpec = useMemo(() => {
    const hunks: ReviewHunk[] = pending.flatMap((turn) => {
      if (session.isWriting(turn.chatPromptId)) return [];
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
    return hunks.length ? { hunks, answer } : null;
  }, [pending, pageId, session, answer]);

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
  // replay the AGENT's edits into this callback. On the legacy pipeline that
  // is prosemirror-collab's `receiveTransaction`, identifiable by the
  // `rebased` meta it sets; on Yjs it is y-prosemirror's replay, stamped with
  // its `y-sync$` plugin key — BlockNote's own remote test. And Cmd-Z, which
  // is the user taking something back rather than writing it.
  useEffect(() => {
    const tiptap = editor._tiptapEditor;
    const onUpdate = ({
      transaction,
      appendedTransactions,
    }: {
      transaction: Transaction;
      appendedTransactions: Transaction[];
    }) => {
      if (
        isReviewWriting() ||
        transaction.getMeta("rebased") !== undefined ||
        transaction.getMeta("y-sync$") !== undefined
      )
        return;
      const ids = getBlocksChangedByTransaction(transaction, appendedTransactions)
        .filter((change) => change.type !== "delete" && !HISTORY.has(change.source.type))
        .map((change) => change.block.id as string);
      session.userEdited(pageId, ids);
    };
    tiptap.on("update", onUpdate);
    return () => void tiptap.off("update", onUpdate);
  }, [editor, session, pageId]);

  return null;
}

/** Change sources that are the user taking an edit back rather than making one. */
const HISTORY: ReadonlySet<string> = new Set(["undo", "redo", "undo-redo"]);

type Nested = { id: string; children?: Nested[] };

function descend<T extends Nested>(blocks: T[]): T[] {
  return blocks.flatMap((b) => [b, ...descend((b.children ?? []) as T[])]);
}
