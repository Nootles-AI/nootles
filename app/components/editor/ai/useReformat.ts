"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import * as Sentry from "@sentry/nextjs";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { track } from "@/app/lib/telemetry";
import { carriedOver, type ReformatCandidate } from "@/app/lib/ai/reformat";
import { blockText, project, type AnyBlock } from "@/app/lib/ai/projection";
import { resolveBatch, warnRejected } from "@/app/lib/ai/validate";
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
export function useReformat(
  editor: Editor | null | undefined,
  pageId?: Id<"pages"> | null,
) {
  const [state, setState] = useState<ReformatState | null>(null);

  const logSuggestion = useMutation(api.ai.suggestions.log);
  const logRef = useRef(logSuggestion);
  useEffect(() => {
    logRef.current = logSuggestion;
  });

  /** What the telemetry row will say about the bar now showing, if any. */
  const shownRef = useRef<{
    shownAt: number;
    latencyMs: number;
    candidateCount: number;
    contextBefore: string;
  } | null>(null);

  const logOutcome = useCallback(
    (
      outcome: "accepted" | "dismissed" | "superseded" | "failed",
      extra?: {
        dismissReason?: "escape";
        blockIds?: string[];
        acceptedText?: string;
        suggestionText?: string;
        chosenIndex?: number;
      },
    ) => {
      const s = shownRef.current;
      shownRef.current = null;
      if (!s) return;
      if (outcome === "accepted") {
        track("suggestion_accepted", {
          kind: "reformat",
          latencyMs: s.latencyMs,
          decisionMs: Math.round(performance.now() - s.shownAt),
        });
      } else {
        track("suggestion_dismissed", {
          kind: "reformat",
          reason: extra?.dismissReason ?? outcome,
        });
      }
      if (!pageId) return;
      defer(() => {
        void logRef
          .current({
            pageId,
            kind: "reformat",
            gateOk: true,
            shown: true,
            outcome,
            latencyMs: s.latencyMs,
            contextBefore: s.contextBefore,
            model: AI.reformat.model,
            candidateCount: s.candidateCount,
            decisionMs: Math.round(performance.now() - s.shownAt),
            ...extra,
          })
          .catch(() => {});
      });
    },
    [pageId],
  );

  const dismiss = useCallback(() => {
    logOutcome("dismissed", { dismissReason: "escape" });
    setState(null);
  }, [logOutcome]);

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
      // Only let this candidate consume the blocks it actually carried. The run
      // is offered to every candidate, but they cover different amounts of it:
      // folding four rows into a table consumes all four, wrapping one phrase in
      // inline maths consumes one. Handing the whole run to each of them deleted
      // the blocks the accepted candidate never mentioned.
      const produced = candidate.html.replace(/<[^>]*>/g, " ");
      const consumable = state.blockIds.filter((id) => {
        const block = blocks.find((x) => x.id === id);
        if (!block) return false;
        return carriedOver(blockText(block), produced) >= AI.reformat.consumedRatio;
      });

      if (!consumable.length) return logOutcome("failed");

      // The model is told to carry the run's first id onto its output, but a
      // candidate covering only part of the run then lands on a block it never
      // read — a table built from two rows overwrote the sentence introducing
      // them. Re-point it at the first block it did consume.
      next[0] = { ...next[0], id: consumable[0] };

      const batch = compileDocHtml(next, {
        current,
        anchorBlockId: consumable[0],
        replacing: consumable,
      });
      if (!batch.ops.length) return logOutcome("failed");
      const { index } = project(blocks);
      const resolved = resolveBatch(batch, index);
      if (!resolved.ok) {
        logOutcome("failed");
        return warnRejected("reformat", resolved);
      }
      const result = applyBatch(editor, resolved.batch, "reformat");
      logOutcome("accepted", {
        suggestionText: candidate.html,
        acceptedText: candidate.html,
        chosenIndex: state.index,
        blockIds: [...new Set([consumable[0], ...Object.values(result.blocks)])],
      });
    } catch (error) {
      // A malformed rewrite is dropped rather than half-applied.
      Sentry.captureException(error, { tags: { feature: "reformat" } });
      logOutcome("failed");
    }
  }, [editor, state, logOutcome]);

  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    let lastKey = "";
    let seq = 0;

    const request = async (ids: string[], html: string, mySeq: number) => {
      const controller = new AbortController();
      abort = controller;
      const started = performance.now();
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
        const latencyMs = Math.round(performance.now() - started);
        track("suggestion_shown", { kind: "reformat", latencyMs });
        shownRef.current = {
          shownAt: performance.now(),
          latencyMs,
          candidateCount: candidates.length,
          contextBefore: html
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(-500),
        };
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
      logOutcome("superseded");
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
      logOutcome("superseded");
    };
  }, [editor, logOutcome]);

  // Whether an inline completion is showing is settled when a key is pressed,
  // not here. Reading it during render both hid the bar for most of a typing
  // session — a completion is showing far more often than not — and was not
  // reactive, so the bar stayed hidden after the ghost had gone.
  return { state, accept, dismiss, cycle };
}
