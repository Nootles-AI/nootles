"use client";

import { useCallback, useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { AI } from "@/app/lib/ai/aiConfig";
import type { ReformatCandidate } from "@/app/lib/ai/reformat";
import { project, type AnyBlock } from "@/app/lib/ai/projection";
import { resolveBatch } from "@/app/lib/ai/validate";
import { applyBatch } from "@/app/lib/ai/apply";
import { toDocHtml } from "@/app/lib/ai/html/serialize";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { compileDocHtml } from "@/app/lib/ai/html/compile";
import { hasSuggestion } from "./ghostText";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

export type ReformatState = {
  /** Anchored to the block being reshaped, so the bar can sit beside it. */
  blockId: string;
  candidates: ReformatCandidate[];
  index: number;
};

const defer = (fn: () => void) => setTimeout(fn, 0);

/**
 * Reformat suggestions for the block you just finished.
 *
 * The trigger is leaving a block: once the caret moves elsewhere, whatever you
 * wrote is done, and reshaping it cannot interrupt a sentence in progress. That
 * matters — an ambient *continuation* was invasive because it guessed at content
 * you had not written yet, whereas this only ever rearranges content you did.
 */
export function useReformat(editor: Editor | null | undefined) {
  const [state, setState] = useState<ReformatState | null>(null);

  const dismiss = useCallback(() => setState(null), []);

  const cycle = useCallback((delta: number) => {
    setState((s) =>
      s
        ? {
            ...s,
            index: (s.index + delta + s.candidates.length) % s.candidates.length,
          }
        : s,
    );
  }, []);

  /** Compile the showing candidate and apply it through the same op pipeline. */
  const accept = useCallback(() => {
    if (!editor || !state) return;
    const candidate = state.candidates[state.index];
    setState(null);
    try {
      const blocks = editor.document as unknown as AnyBlock[];
      const current = parseDocHtml(toDocHtml(blocks));
      const next = parseDocHtml(candidate.html);
      const batch = compileDocHtml(next, {
        current,
        anchorBlockId: state.blockId,
      });
      if (!batch.ops.length) return;
      const { index } = project(blocks);
      const resolved = resolveBatch(batch, index);
      if (!resolved.ok) return;
      applyBatch(editor, resolved.batch);
    } catch {
      // A malformed rewrite is dropped rather than half-applied.
    }
  }, [editor, state]);

  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    let lastBlockId: string | null = null;
    let seq = 0;

    const run = async (blockId: string, html: string, mySeq: number) => {
      const controller = new AbortController();
      abort = controller;
      try {
        const res = await fetch("/api/reformat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ block: html }),
          signal: controller.signal,
        });
        if (!res.ok || mySeq !== seq) return;
        const { candidates } = (await res.json()) as {
          candidates: ReformatCandidate[];
        };
        if (mySeq !== seq || !candidates?.length) return;
        setState({ blockId, candidates, index: 0 });
      } catch {
        // superseded or offline
      }
    };

    const onSelection = () => {
      let blockId: string | null = null;
      try {
        blockId = editor.getTextCursorPosition().block.id as string;
      } catch {
        return;
      }
      if (blockId === lastBlockId) return;

      const left = lastBlockId;
      lastBlockId = blockId;
      // The caret moved to a different block, so the previous one is finished.
      seq++;
      setState(null);
      if (timer) clearTimeout(timer);
      abort?.abort();
      if (!left) return;

      const blocks = editor.document as unknown as AnyBlock[];
      const block = blocks.find((b) => b.id === left);
      if (!block) return;
      // Only prose is worth reshaping — a code block or diagram is already a
      // deliberate choice of modality.
      if (block.type !== "paragraph") return;
      const html = toDocHtml([block]);
      if (html.replace(/<[^>]*>/g, "").trim().length < AI.reformat.minChars) {
        return;
      }

      const mySeq = seq;
      timer = setTimeout(
        () => defer(() => void run(left, html, mySeq)),
        AI.reformat.debounceMs,
      );
    };

    const unsub = editor.onSelectionChange(onSelection, false);
    return () => {
      unsub?.();
      if (timer) clearTimeout(timer);
      abort?.abort();
      seq++;
    };
  }, [editor]);

  // The inline completion owns Tab. Standing aside avoids two suggestions
  // competing for one key at the same caret.
  const blocked = !!editor && hasSuggestion(editor.prosemirrorState);

  return { state: blocked ? null : state, accept, dismiss, cycle };
}
