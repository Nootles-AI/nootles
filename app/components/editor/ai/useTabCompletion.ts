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
import { compileDocHtml, layoutDiagram } from "@/app/lib/ai/html/compile";
import { INLINE_TAGS } from "@/app/lib/ai/html/grammar";
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

/** The first block-level tag in the text, or -1. Inline marks are skipped:
 * `<code>`, `<strong>` and friends are prose, not a new block. */
function findBlockTag(text: string): number {
  const re = /<\s*(\/?)([a-zA-Z][\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!INLINE_TAGS.has(m[2].toLowerCase())) return m.index;
  }
  return -1;
}

/**
 * A completion that opens or closes a BLOCK, rather than continuing prose.
 *
 * Inline marks must not count. Treating them as structure truncated
 * "the <code>maxRetries</code> option controls…" at the closing tag and tried
 * to compile the fragment into ops, so inline code in a suggestion arrived as a
 * mangled half-sentence.
 */
function isStructural(text: string): boolean {
  return findBlockTag(text) !== -1;
}

/**
 * The prose a structural completion writes before it opens its first element.
 * Finishing "Here's a dia" into "…gram of the quadratic formula:" and then
 * drawing the diagram is one suggestion, and both halves have to be visible.
 */
function proseTail(text: string): string {
  const cut = findBlockTag(text);
  return (cut === -1 ? text : text.slice(0, cut)).replace(/\n+$/, "");
}

/** Index just past `<tag>…</tag>`, counting nesting, or -1 if it never closes. */
function endOfElement(text: string, tag: string): number {
  const re = new RegExp(`<(/?)${tag}(?=[\\s/>])`, "gi");
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[1]) {
      depth++;
      continue;
    }
    if (--depth > 0) continue;
    const gt = text.indexOf(">", m.index);
    return gt === -1 ? -1 : gt + 1;
  }
  return -1;
}

/**
 * The completion cut down to one block: the prose finishing the current block,
 * the tag closing it, and the first element opened after that.
 *
 * Left alone the model keeps writing — asked to finish "Here's a dia" it drew
 * the diagram and then toured every other block type in the grammar. That made
 * the preview a lie, showing one block where Tab would have applied five. `done`
 * says the element closed, so the stream can be cut short.
 */
function firstBlock(acc: string): { text: string; done: boolean } {
  const cut = findBlockTag(acc);
  if (cut === -1) return { text: acc, done: false };
  let head = acc.slice(0, cut);
  let rest = acc.slice(cut);
  const closing = /^<\/[a-zA-Z][\w-]*\s*>\s*/.exec(rest);
  if (closing) {
    head += closing[0];
    rest = rest.slice(closing[0].length);
  }
  const open = /^<([a-zA-Z][\w-]*)[^>]*>/.exec(rest);
  if (!open) return { text: head + rest, done: false };
  const end = endOfElement(rest, open[1]);
  if (end === -1) return { text: head + rest, done: false };
  return { text: head + rest.slice(0, end), done: true };
}

/**
 * Preview built from a HALF-ARRIVED completion, so a diagram draws itself as its
 * shapes come in rather than sitting behind a spinner for a few seconds.
 *
 * The partial markup is malformed by definition — the last tag is usually cut
 * mid-attribute — but DOM parsing is forgiving, so complete elements come back
 * and the rest is ignored. Positions run through the same layout the compiler
 * uses, so nothing shifts when the finished version replaces it.
 */
function partialPreview(acc: string): { label: string; preview?: Preview } | null {
  let nodes;
  try {
    nodes = parseDocHtml(acc);
  } catch {
    return null;
  }
  const canvas = nodes.find((n) => n.type === "canvas");
  if (canvas && canvas.type === "canvas") {
    if (!canvas.nodes.length) return { label: "Add diagram" };
    const laid = layoutDiagram(canvas.nodes, canvas.edges);
    return { label: "Add diagram", preview: { kind: "diagram", ...laid } };
  }
  const code = nodes.find((n) => n.type === "codeBlock");
  if (code && code.type === "codeBlock") {
    return {
      label: "Insert code block",
      preview: { kind: "code", language: code.language, code: code.code },
    };
  }
  const math = nodes.find((n) => n.type === "mathBlock");
  if (math && math.type === "mathBlock") {
    const lines = math.rows.filter(Boolean);
    if (!lines.length) return { label: "Insert math block" };
    return { label: "Insert math block", preview: { kind: "math", lines } };
  }
  return null;
}

/** Cheap signal for "enough has arrived to be worth redrawing". */
function previewSignature(acc: string): string {
  const closed = (acc.match(/<\/ab-node>/g) ?? []).length;
  const edges = (acc.match(/<ab-edge/g) ?? []).length;
  return `${proseTail(acc)}:${closed}:${edges}:${acc.length >> 5}`;
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
    if (block.type === "mathBlock") {
      const lines = String(block.props?.source ?? "").split("\n").filter(Boolean);
      return {
        label: "Insert math block",
        ...(lines.length ? { preview: { kind: "math" as const, lines } } : {}),
      };
    }
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
      if (visible.length < AI.minContextChars) return null;
      return { ...split, cursorBlockId, blocks };
    };

    const run = async (mySeq: number) => {
      const ctx = context();
      if (!ctx) return;
      const controller = new AbortController();
      abort = controller;
      const started = performance.now();

      let acc = "";
      let raw = "";
      let lastSig = "";
      let headLitAt = 0;
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
          raw += value;
          const bounded = firstBlock(raw);
          acc = bounded.text;
          if (bounded.done) break; // the block closed; nothing after it is ours
          if (isStructural(acc)) {
            // Draw what has arrived so far. The batch stays null until the
            // stream ends, so Tab queues rather than applying a half-diagram.
            const sig = previewSignature(acc);
            if (sig !== lastSig) {
              lastSig = sig;
              const partial = partialPreview(acc);
              setAction(
                view(),
                partial?.label ?? "Thinking",
                null,
                partial?.preview,
                proseTail(acc),
              );
            }
          } else {
            if (!headLitAt) headLitAt = performance.now();
            setGhost(view(), acc.replace(/^\n+/, ""), true);
          }
        }
      } catch {
        return; // superseded or offline
      }
      // We have all we intend to use; stop paying for the rest of the stream.
      controller.abort();
      if (mySeq !== seq) return;

      if (!isStructural(acc)) {
        // Prose already streamed in; drop the live edge once it has stopped,
        // but never before the head has been visible long enough to see.
        if (acc.trim()) {
          const text = acc.replace(/^\n+/, "");
          const lit = headLitAt ? performance.now() - headLitAt : Infinity;
          const settle = () => {
            if (mySeq === seq) setGhost(view(), text, false);
          };
          if (lit >= AI.timing.minStreamHeadMs) settle();
          else setTimeout(settle, AI.timing.minStreamHeadMs - lit);
          shown = { kind: "prose", latencyMs: elapsed(started) };
        }
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
        setAction(view(), label, resolved.batch, preview, proseTail(acc));
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
