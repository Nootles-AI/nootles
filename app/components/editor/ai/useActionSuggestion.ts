"use client";

import { useEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { project, type AnyBlock } from "@/app/lib/ai/projection";
import { resolveBatch } from "@/app/lib/ai/validate";
import { applyBatch } from "@/app/lib/ai/apply";
import { compileAction } from "@/app/lib/ai/compileAction";
import { plannerOutput } from "@/app/lib/ai/actions";
import {
  setAction,
  clearSuggestion,
  isSuggestionDispatch,
  setActionApplyHandler,
} from "./ghostText";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

const DEBOUNCE_MS = 900;
const MIN_CONTEXT = 6;

/**
 * Drives the "action lane": on a longer pause, the planner (Sonnet) reads the
 * doc projection and may propose ONE structured action (insert code/math/
 * diagram, or reformat). We compile it to Phase-2 ops, validate them, and show
 * a caret chip. A non-null planner result overrides the prose ghost — the model
 * is told to be conservative, so a suggestion means it's genuinely worthwhile.
 * Tab applies the (already-validated) batch via the shared apply handler.
 */
export function useActionSuggestion(
  editor: Editor | null | undefined,
  pageId: Id<"pages"> | null | undefined,
) {
  const appendBatch = useMutation(api.ai.opLog.appendBatch);
  // Keep the mutation in a ref so the effect below depends only on the stable
  // (editor, pageId) — re-subscribing to the editor on every render feeds a
  // BlockNote store↔React update loop.
  const appendRef = useRef(appendBatch);
  useEffect(() => {
    appendRef.current = appendBatch;
  });

  useEffect(() => {
    if (!editor || !pageId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;

    // How an accepted action batch is applied + logged (called by the plugin's
    // Tab handler, which only has access to the editor).
    setActionApplyHandler((batch) => {
      applyBatch(editor, batch);
      void appendRef.current({ pageId, source: "ai", ops: batch.ops }).catch(
        () => {},
      );
    });

    const gate = () => {
      const state = editor.prosemirrorState;
      const sel = state.selection;
      if (!sel.empty) return null;
      if (!sel.$from.parent.isTextblock) return null;
      const before = state.doc.textBetween(0, sel.from, "\n");
      if (before.trim().length < MIN_CONTEXT) return null;
      const after = state.doc.textBetween(sel.from, state.doc.content.size, "\n");
      let currentBlockId: string;
      try {
        currentBlockId = editor.getTextCursorPosition().block.id;
      } catch {
        return null;
      }
      const projection = project(editor.document as unknown as AnyBlock[]).text;
      return { projection, before, after, currentBlockId };
    };

    const run = async () => {
      const ctx = gate();
      if (!ctx) return;
      const controller = new AbortController();
      abort = controller;
      try {
        const res = await fetch("/api/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projection: ctx.projection,
            before: ctx.before,
            after: ctx.after,
          }),
          signal: controller.signal,
        });
        if (!res.ok || controller.signal.aborted) return;
        const parsed = plannerOutput.safeParse(await res.json());
        if (!parsed.success || parsed.data.action.kind === "none") return;

        // The doc must be untouched since we asked (same caret + same text).
        const now = gate();
        if (
          !now ||
          now.currentBlockId !== ctx.currentBlockId ||
          now.before !== ctx.before
        ) {
          return;
        }

        const batch = compileAction(
          editor,
          parsed.data.action,
          ctx.currentBlockId,
        );
        if (!batch) return;
        const { index } = project(editor.document as unknown as AnyBlock[]);
        const resolved = resolveBatch(batch, index);
        if (!resolved.ok) return; // reject anything that references bad ids
        setAction(editor.prosemirrorView, parsed.data.label, resolved.batch);
      } catch {
        // Aborted (superseded) or a network hiccup — no suggestion.
      }
    };

    const schedule = () => {
      if (isSuggestionDispatch()) return; // our own suggestion transaction
      if (timer) clearTimeout(timer);
      abort?.abort();
      clearSuggestion(editor.prosemirrorView);
      timer = setTimeout(run, DEBOUNCE_MS);
    };

    const unsubChange = editor.onChange(schedule, false);
    const unsubSelection = editor.onSelectionChange(schedule, false);

    return () => {
      unsubChange?.();
      unsubSelection?.();
      if (timer) clearTimeout(timer);
      abort?.abort();
      setActionApplyHandler(null);
    };
  }, [editor, pageId]);
}
