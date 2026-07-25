"use client";

import { useEffect } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { setGhost, clearSuggestion, isSuggestionDispatch } from "./ghostText";

// The op layer is dynamic across schemas; a loosely-typed editor handle is fine.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

const DEBOUNCE_MS = 350;
const MIN_CONTEXT = 3;

/**
 * Drives ghost-text tab completion. Watches the editor; when the user pauses
 * with a collapsed caret at the end of a prose text block, it fetches a short
 * streamed completion from /api/complete and feeds it to the ghost-text plugin.
 *
 * Every change aborts the in-flight request (superseded completions stop
 * costing tokens) and clears the current ghost. The plugin renders and accepts;
 * this hook only decides *when* to complete and streams the text in.
 */
export function useTabCompletion(editor: Editor | null | undefined) {
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;

    // Gate: only complete at a collapsed caret sitting at the end of a prose
    // textblock (code/math/canvas are void nodes, so their caret never lands in
    // a textblock — they're excluded for free). Returns the context or null.
    const gate = (): { before: string; after: string } | null => {
      const state = editor.prosemirrorState;
      const sel = state.selection;
      if (!sel.empty) return null;
      const $from = sel.$from;
      if (!$from.parent.isTextblock) return null;
      if ($from.parentOffset !== $from.parent.content.size) return null;
      const before = state.doc.textBetween(0, sel.from, "\n");
      if (before.trim().length < MIN_CONTEXT) return null;
      const after = state.doc.textBetween(sel.from, state.doc.content.size, "\n");
      return { before, after };
    };

    const run = async () => {
      const gated = gate();
      if (!gated) return;
      const controller = new AbortController();
      abort = controller;
      try {
        const res = await fetch("/api/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(gated),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body
          .pipeThrough(new TextDecoderStream())
          .getReader();
        let acc = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (controller.signal.aborted) break;
          // Bail if the caret moved since we started — a stale ghost is worse
          // than none.
          if (!gate()) {
            controller.abort();
            break;
          }
          acc += value;
          // FIM returns a raw continuation with the correct spacing already, so
          // we show it verbatim (just drop any leading newline for inline use).
          const text = acc.replace(/^\n+/, "");
          setGhost(editor.prosemirrorView, text);
        }
      } catch {
        // Aborted (superseded) or a network hiccup — nothing to show.
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
    };
  }, [editor]);
}
