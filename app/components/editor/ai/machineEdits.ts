import type { Editor as TiptapEditor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { isApplyingAi } from "@/app/lib/debugRing";
import { isReviewWriting } from "@/app/lib/ai/review/attribution";

/**
 * Whether a transaction is one the person did not type: the agent's applier,
 * the review writing (its apply, discard and restore — all one `transact`,
 * which dispatches after the applier's own flag has already come down, so the
 * review's flag is the one that covers it), or steps replayed into the editor:
 * another tab's, a collaborator's, a fork landing.
 */
export function isMachineEdit(transaction: Transaction): boolean {
  return (
    isApplyingAi() ||
    isReviewWriting() ||
    transaction.getMeta("y-sync$") !== undefined ||
    !!transaction.getMeta("collab$") ||
    !!transaction.getMeta("rebased")
  );
}

/**
 * The last document a machine edit left the editor holding.
 *
 * The ambient lanes answer a pause in the person's writing, and they listen on
 * BlockNote's change events, which carry no transaction to ask. Without this
 * every edit the agent applied read as the person typing, and each one bought a
 * completion and a reformat nobody was writing — measured, one of each per
 * `edit_page`. A lane asks whether the document it is looking at is this one:
 * if so the change was not theirs, and the lane stands down until they act.
 *
 * Read off the editor's state rather than the transaction, because plugins
 * append transactions of their own and the document the change events see is
 * the one after those.
 */
export function watchMachineEdits(tiptap: TiptapEditor): {
  isMachineDoc: (doc: unknown) => boolean;
  stop: () => void;
} {
  let last: unknown = null;
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    last = isMachineEdit(transaction) ? tiptap.state.doc : null;
  };
  tiptap.on("transaction", onTransaction);
  return {
    isMachineDoc: (doc) => doc !== null && doc === last,
    stop: () => {
      tiptap.off("transaction", onTransaction);
    },
  };
}
