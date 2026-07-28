"use client";

import { useEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { project, type AnyBlock } from "@/app/lib/ai/projection";
import { resolveBatch } from "@/app/lib/ai/validate";
import { applyBatch } from "@/app/lib/ai/apply";
import { toDocHtml, toDocHtmlSplit } from "@/app/lib/ai/html/serialize";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { compileDocHtml } from "@/app/lib/ai/html/compile";
import type { Batch } from "@/convex/ai/operations";
import {
  setGhost,
  setAction,
  clearSuggestion,
  isSuggestionDispatch,
  setActionApplyHandler,
  type Preview,
} from "./ghostText";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

const MIN_CONTEXT = 3;

/**
 * One example of each custom element, so a cold document still completes into
 * our grammar. Measured: given no example, the model falls back to standard
 * `<pre><code>`; given one, it adopts our elements exactly. A comment is the
 * natural place for it — the parser ignores comments entirely.
 */
const PREAMBLE = `<!-- auto-board document. Blocks: <p>, <h2>, <ul><li>, <blockquote>,
<ab-code-block lang="python">code</ab-code-block>,
<ab-math-block><ab-math-line>a = 1</ab-math-line></ab-math-block>,
<ab-diagram><ab-node shape="rectangle" x="0" y="0">Step</ab-node><ab-edge from="n1" to="n2"></ab-edge></ab-diagram> -->
`;

/** A completion that opens or closes an element, rather than continuing prose. */
function isStructural(text: string): boolean {
  return /<\s*\/?[a-zA-Z]/.test(text);
}

/** Human label + preview for whatever the completion turned out to be. */
function describe(batch: Batch): { label: string; preview?: Preview } {
  for (const op of batch.ops) {
    if (op.kind !== "insertBlocks") continue;
    const block = op.blocks[0];
    if (block.type === "codeBlock") {
      const props = block.props ?? {};
      return {
        label: "Insert code block",
        preview: {
          kind: "code",
          language: String(props.language ?? "plaintext"),
          code: String(props.code ?? ""),
        },
      };
    }
    if (block.type === "canvas") {
      const nodes = batch.ops
        .filter((o) => o.kind === "addShape")
        .map((o, i) => {
          const s = o as Extract<typeof o, { kind: "addShape" }>;
          return {
            tempId: s.tempId,
            shape: s.shape as string,
            label: s.label ?? "",
            x: s.position?.x ?? i * 220,
            y: s.position?.y ?? 0,
          };
        });
      const edges = batch.ops
        .filter((o) => o.kind === "connectEdge")
        .map((o) => {
          const e = o as Extract<typeof o, { kind: "connectEdge" }>;
          return {
            source: "tempId" in e.source ? e.source.tempId : e.source.shapeId,
            target: "tempId" in e.target ? e.target.tempId : e.target.shapeId,
          };
        });
      return {
        label: "Add diagram",
        ...(nodes.length ? { preview: { kind: "diagram", nodes, edges } } : {}),
      };
    }
    if (block.type === "mathBlock") return { label: "Insert math block" };
    if (block.type === "heading") return { label: "Insert heading" };
  }
  return { label: "Apply suggestion" };
}

/**
 * The single inline-suggestion lane.
 *
 * The document is serialized into the auto-board HTML language and split at the
 * caret; the model completes the middle. Nothing classifies intent — if the
 * natural continuation is a code block, the model writes one, because that's
 * what comes next in the grammar. The SHAPE of the completion decides how it's
 * shown: bare text streams as ghost text, markup is compiled into ops and
 * offered as a previewed block. Tab accepts either.
 */
export function useTabCompletion(
  editor: Editor | null | undefined,
  pageId?: Id<"pages"> | null,
) {
  const appendBatch = useMutation(api.ai.opLog.appendBatch);
  const logSuggestion = useMutation(api.ai.suggestions.log);
  const appendRef = useRef(appendBatch);
  const logRef = useRef(logSuggestion);
  useEffect(() => {
    appendRef.current = appendBatch;
    logRef.current = logSuggestion;
  });

  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    let seq = 0;
    let shown: { kind: string; latencyMs: number } | null = null;

    const view = () => editor.prosemirrorView;
    // Convex mutations trigger React state; dispatching one from inside the
    // editor's update cycle re-enters rendering. Always defer writes out of it.
    const defer = (fn: () => void) => setTimeout(fn, 0);

    setActionApplyHandler((batch) => {
      const s = shown;
      shown = null;
      applyBatch(editor, batch);
      if (!pageId) return;
      defer(() => {
        void appendRef
          .current({ pageId, source: "ai", ops: batch.ops })
          .catch(() => {});
        if (s) {
          void logRef
            .current({
              pageId,
              kind: s.kind,
              gateOk: true,
              shown: true,
              outcome: "accepted",
              latencyMs: s.latencyMs,
            })
            .catch(() => {});
        }
      });
    });

    const context = () => {
      const state = editor.prosemirrorState;
      const sel = state.selection;
      if (!sel.empty || !sel.$from.parent.isTextblock) return null;
      let cursorBlockId: string;
      try {
        cursorBlockId = editor.getTextCursorPosition().block.id as string;
      } catch {
        return null;
      }
      const blocks = editor.document as unknown as AnyBlock[];
      const split = toDocHtmlSplit(blocks, cursorBlockId, sel.$from.parentOffset);
      if (!split) return null;
      // Enough written to complete from.
      const visible = split.prefix.replace(/<[^>]*>/g, "").trim();
      if (visible.length < MIN_CONTEXT) return null;
      return { ...split, cursorBlockId, blocks };
    };

    const run = async (mySeq: number) => {
      const ctx = context();
      if (!ctx) return;
      const controller = new AbortController();
      abort = controller;
      const started = performance.now();

      let acc = "";
      try {
        const res = await fetch("/api/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            before: PREAMBLE + ctx.prefix,
            after: ctx.suffix,
            mode: "html",
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (mySeq !== seq) return;
          acc += value;
          if (isStructural(acc)) {
            // Can't render markup until it's complete; show intent meanwhile.
            setAction(view(), "Thinking", null);
          } else {
            setGhost(view(), acc.replace(/^\n+/, ""));
          }
        }
      } catch {
        return; // superseded or offline
      }
      if (mySeq !== seq) return;

      if (!isStructural(acc)) {
        // Prose already streamed in as ghost text.
        if (acc.trim()) shown = { kind: "prose", latencyMs: elapsed(started) };
        return;
      }

      // Structural: rebuild the document with the completion spliced in, and
      // let the compiler work out which ops that implies.
      try {
        const next = parseDocHtml(ctx.prefix + acc + ctx.suffix);
        const current = parseDocHtml(toDocHtml(ctx.blocks));
        const batch = compileDocHtml(next, {
          current,
          anchorBlockId: ctx.cursorBlockId,
        });
        if (!batch.ops.length) return clear();
        const { index } = project(ctx.blocks);
        const resolved = resolveBatch(batch, index);
        if (!resolved.ok) return clear();
        const { label, preview } = describe(resolved.batch);
        shown = { kind: label, latencyMs: elapsed(started) };
        setAction(view(), label, resolved.batch, preview);
      } catch {
        clear();
      }
    };

    const elapsed = (from: number) => Math.round(performance.now() - from);
    const clear = () => {
      shown = null;
      clearSuggestion(view());
    };

    const schedule = () => {
      if (isSuggestionDispatch()) return; // our own suggestion transaction
      if (timer) clearTimeout(timer);
      abort?.abort();
      seq++;
      if (shown && pageId) {
        const s = shown;
        defer(() => {
          void logRef
            .current({
              pageId,
              kind: s.kind,
              gateOk: true,
              shown: true,
              outcome: "dismissed",
              latencyMs: s.latencyMs,
            })
            .catch(() => {});
        });
      }
      shown = null;
      const mySeq = seq;
      // onChange fires inside the editor's transaction cycle; dispatching
      // another transaction synchronously from here re-enters rendering.
      defer(() => {
        if (mySeq === seq) clearSuggestion(view());
      });
      timer = setTimeout(() => void run(mySeq), AI.timing.ghostDebounceMs);
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
