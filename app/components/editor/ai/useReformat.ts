"use client";

import { useCallback, useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { AI } from "@/app/lib/ai/aiConfig";
import type { ReformatCandidate } from "@/app/lib/ai/reformat";
import { blockText, project, type AnyBlock } from "@/app/lib/ai/projection";
import { resolveBatch } from "@/app/lib/ai/validate";
import { applyBatch } from "@/app/lib/ai/apply";
import { toDocHtml } from "@/app/lib/ai/html/serialize";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { compileDocHtml } from "@/app/lib/ai/html/compile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

export type ReformatState = {
  /** Anchored to the first block of the run, so the bar sits beside it. */
  blockId: string;
  /** Every block the rewrite may consume — the run, not just one block. */
  blockIds: string[];
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
        // Folding a run into one block means the rest have to go, and only we
        // know which ones were on the table.
        replacing: state.blockIds,
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
    let lastKey = "";
    let seq = 0;

    const request = async (ids: string[], html: string, mySeq: number) => {
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
        setState({ blockId: ids[0], blockIds: ids, candidates, index: 0 });
      } catch {
        // superseded or offline
      }
    };

    const isProse = (b: AnyBlock | undefined) =>
      !!b && b.type === "paragraph" && !!blockText(b).trim();
    const isBlank = (b: AnyBlock | undefined) =>
      !!b && b.type === "paragraph" && !blockText(b).trim();

    /**
     * The run of paragraphs the caret is in or has just left.
     *
     * Enter starts a new block, so one snippet or table arrives as several — and
     * people put a blank line between rows, so a single empty paragraph is
     * spacing. Two in a row, or any other block type, ends it.
     */
    const runAtCursor = (): AnyBlock[] | null => {
      let cursorId: string;
      try {
        cursorId = editor.getTextCursorPosition().block.id as string;
      } catch {
        return null;
      }
      const blocks = editor.document as unknown as AnyBlock[];
      let end = blocks.findIndex((b) => b.id === cursorId);
      if (end === -1) return null;
      // Sitting on a fresh empty block: the run is the one just finished.
      while (end >= 0 && !isProse(blocks[end])) end--;
      if (end < 0) return null;

      let first = end;
      let sawBlank = false;
      for (let i = end - 1; i >= 0 && end - i < AI.reformat.maxBlocks; i--) {
        if (isProse(blocks[i])) {
          first = i;
          sawBlank = false;
          continue;
        }
        if (isBlank(blocks[i]) && !sawBlank) {
          sawBlank = true;
          continue;
        }
        break;
      }
      return blocks.slice(first, end + 1);
    };

    /**
     * Runs on edits and on caret moves alike. Leaving a block finishes it, but so
     * does simply stopping — type an obvious table and never move, and waiting
     * for you to leave would mean never offering it at all.
     */
    const schedule = () => {
      const run = runAtCursor();
      if (!run?.length) return;
      const html = toDocHtml(run);
      const key = run.map((b) => b.id).join(",") + "|" + html;
      // Same run, same text: whatever is showing already answers it.
      if (key === lastKey) return;
      lastKey = key;

      seq++;
      setState(null);
      if (timer) clearTimeout(timer);
      abort?.abort();

      if (html.replace(/<[^>]*>/g, "").trim().length < AI.reformat.minChars) {
        return;
      }
      const ids = run.map((b) => b.id);
      const mySeq = seq;
      timer = setTimeout(
        () => defer(() => void request(ids, html, mySeq)),
        AI.reformat.debounceMs,
      );
    };

    const unsubChange = editor.onChange(schedule, false);
    const unsubSelection = editor.onSelectionChange(schedule, false);
    return () => {
      unsubChange?.();
      unsubSelection?.();
      if (timer) clearTimeout(timer);
      abort?.abort();
      seq++;
    };
  }, [editor]);

  // Whether an inline completion is showing is settled when a key is pressed,
  // not here. Reading it during render both hid the bar for most of a typing
  // session — a completion is showing far more often than not — and was not
  // reactive, so the bar stayed hidden after the ghost had gone.
  return { state, accept, dismiss, cycle };
}
