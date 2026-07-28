"use client";

import { useEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { project, type AnyBlock } from "@/app/lib/ai/projection";
import {
  propose,
  flattenBlocks,
  type FlatBlock,
  type Proposal,
} from "@/app/lib/ai/heuristics";
import { resolveBatch } from "@/app/lib/ai/validate";
import { applyBatch } from "@/app/lib/ai/apply";
import { compileAction } from "@/app/lib/ai/compileAction";
import type { Action } from "@/app/lib/ai/actions";
import type { Batch } from "@/convex/ai/operations";
import {
  setAction,
  clearSuggestion,
  isSuggestionDispatch,
  setActionApplyHandler,
  type Preview,
} from "./ghostText";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

type Ctx = {
  flat: FlatBlock[];
  docBlocks: AnyBlock[];
  cursorBlockId: string;
  /** Cursor-block text at request time — cheap staleness anchor. */
  anchorText: string;
};

type Entry = { label: string; batch: Batch; preview?: Preview };

/**
 * The ambient suggestion lane, as a 3-tier filter.
 *
 *   Tier 0  local heuristics — runs on every change, free, ~90% end here
 *   Tier 1  binary gate      — "worth interrupting?", ~250ms, defaults to NO
 *   Tier 2  content          — local compile, FIM, or the strong model
 *
 * Everything proposed is anchored to the cursor block, so a suggestion can't
 * target an unrelated part of the document. Work is discarded whenever the
 * document moves on (monotonic `seq` + a text anchor), and results are cached so
 * pausing repeatedly in one spot replays instantly.
 */
export function useActionSuggestion(
  editor: Editor | null | undefined,
  pageId: Id<"pages"> | null | undefined,
) {
  const appendBatch = useMutation(api.ai.opLog.appendBatch);
  const logSuggestion = useMutation(api.ai.suggestions.log);

  // Convex mutation identities aren't stable across renders; keeping them in a
  // ref lets the effect below depend only on (editor, pageId). Re-subscribing to
  // the editor on every render feeds a BlockNote store↔React update loop.
  const appendRef = useRef(appendBatch);
  const logRef = useRef(logSuggestion);
  useEffect(() => {
    appendRef.current = appendBatch;
    logRef.current = logSuggestion;
  });

  useEffect(() => {
    if (!editor || !pageId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    let seq = 0;
    let shown: { kind: string; latencyMs: number } | null = null;
    const recentIds = new Set<string>();
    const cache = new Map<string, Entry>();

    const view = () => editor.prosemirrorView;

    // Convex mutations trigger React state updates. `schedule()` runs inside the
    // editor's transaction/update cycle, so dispatching a mutation from there
    // re-enters rendering and trips "Maximum update depth exceeded". Always
    // defer writes to a macrotask so they land after the cycle completes.
    const defer = (fn: () => void) => setTimeout(fn, 0);

    const record = (
      kind: string,
      gateOk: boolean,
      wasShown: boolean,
      outcome: "gated" | "accepted" | "dismissed" | "superseded" | "failed",
      latencyMs: number,
    ) => {
      defer(() => {
        void logRef
          .current({ pageId, kind, gateOk, shown: wasShown, outcome, latencyMs })
          .catch(() => {});
      });
    };

    setActionApplyHandler((batch) => {
      // Claim the shown suggestion first: applying mutates the doc, which
      // immediately re-enters schedule() and would otherwise log a dismissal.
      const s = shown;
      shown = null;
      applyBatch(editor, batch);
      defer(() => {
        void appendRef
          .current({ pageId, source: "ai", ops: batch.ops })
          .catch(() => {});
      });
      if (s) record(s.kind, true, true, "accepted", s.latencyMs);
    });

    const buildCtx = (): Ctx | null => {
      const state = editor.prosemirrorState;
      const sel = state.selection;
      if (!sel.empty || !sel.$from.parent.isTextblock) return null;
      let cursorBlockId: string;
      try {
        cursorBlockId = editor.getTextCursorPosition().block.id as string;
      } catch {
        return null;
      }
      const docBlocks = editor.document as unknown as AnyBlock[];
      const flat = flattenBlocks(docBlocks);
      const anchor = flat.find((b) => b.id === cursorBlockId);
      if (!anchor) return null;
      return { flat, docBlocks, cursorBlockId, anchorText: anchor.text };
    };

    /** Turn a confirmed proposal into a concrete Action. Only code/diagram call out. */
    const materialize = async (
      p: Proposal,
      ctx: Ctx,
      signal: AbortSignal,
    ): Promise<{ action: Action; preview?: Preview } | null> => {
      if (p.kind === "formatCode") {
        return {
          action: {
            kind: "reformat",
            blockIds: p.blockIds,
            to: "codeBlock",
            language: p.language,
          },
        };
      }
      if (p.kind === "formatMath") {
        return {
          action: { kind: "reformat", blockIds: p.blockIds, to: "mathBlock" },
        };
      }
      if (p.kind === "reformat") {
        return {
          action: {
            kind: "reformat",
            blockIds: p.blockIds,
            to: p.to,
            headingLevel: p.headingLevel,
          },
        };
      }

      const post = async (payload: unknown) => {
        const res = await fetch("/api/content", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
        return res.ok ? await res.json() : null;
      };

      if (p.kind === "code") {
        const out = await post({
          kind: "code",
          language: p.language,
          intent: p.intent,
        });
        if (!out?.code) return null;
        return {
          action: { kind: "insertCode", language: out.language, code: out.code },
          preview: { kind: "code", language: out.language, code: out.code },
        };
      }

      // diagram — the only branch that needs the strong model.
      const { text } = project(ctx.docBlocks, {
        cursorBlockId: ctx.cursorBlockId,
        window: AI.projection.window,
        recentIds,
      });
      const out = await post({
        kind: "diagram",
        projection: text,
        nearbyText: p.nearbyText,
      });
      if (!out?.nodes?.length) return null;
      return {
        action: {
          kind: "insertDiagram",
          nodes: out.nodes,
          edges: out.edges ?? [],
        },
        preview: {
          kind: "diagram",
          nodes: out.nodes,
          edges: out.edges ?? [],
        },
      };
    };

    const display = (e: Entry, kind: string, latencyMs: number) => {
      // Claim `shown` first: if a Tab was queued while this was loading,
      // setAction applies immediately and the handler needs to see it.
      shown = { kind, latencyMs };
      setAction(view(), e.label, e.batch, e.preview);
    };

    const run = async (mySeq: number) => {
      const ctx = buildCtx();
      if (!ctx) return;

      // Tier 0 — free. Most pauses stop here without touching the network.
      const p = propose({ blocks: ctx.flat, cursorBlockId: ctx.cursorBlockId });
      if (!p) return;

      const key = `${ctx.cursorBlockId}|${ctx.anchorText}|${p.kind}|${p.blockIds.join(",")}`;
      const hit = cache.get(key);
      if (hit) {
        display(hit, p.kind, 0);
        return;
      }

      const controller = new AbortController();
      abort = controller;
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);

      // Tier 1 — binary confirm.
      let gateOk = false;
      try {
        const res = await fetch("/api/gate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            proposal: p.gateProposal,
            nearbyText: p.nearbyText,
          }),
          signal: controller.signal,
        });
        gateOk = res.ok && (await res.json())?.ok === true;
      } catch {
        return; // aborted or offline
      }
      if (mySeq !== seq) return;
      if (!gateOk) {
        record(p.kind, false, false, "gated", elapsed());
        return;
      }

      // Paint the chip now; Tab stays inert until the batch lands.
      setAction(view(), p.label, null);

      // Tier 2 — content.
      let mat: { action: Action; preview?: Preview } | null = null;
      try {
        mat = await materialize(p, ctx, controller.signal);
      } catch {
        mat = null;
      }
      if (mySeq !== seq) return;

      const fail = () => {
        clearSuggestion(view());
        shown = null;
        record(p.kind, true, false, "failed", elapsed());
      };
      if (!mat) return fail();

      const batch = compileAction(editor, mat.action, p.anchorBlockId);
      if (!batch) return fail();
      // Validate against the FULL index (the prompt may have been windowed).
      const { index } = project(editor.document as unknown as AnyBlock[]);
      const resolved = resolveBatch(batch, index);
      if (!resolved.ok) return fail();

      // Anchor check: the cursor block must not have changed under us.
      const now = buildCtx();
      if (!now || now.cursorBlockId !== ctx.cursorBlockId || now.anchorText !== ctx.anchorText) {
        clearSuggestion(view());
        shown = null;
        record(p.kind, true, false, "superseded", elapsed());
        return;
      }

      const entry: Entry = {
        label: p.label,
        batch: resolved.batch,
        preview: mat.preview,
      };
      cache.set(key, entry);
      if (cache.size > AI.cache.max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      display(entry, p.kind, elapsed());
    };

    const schedule = () => {
      if (isSuggestionDispatch()) return; // our own suggestion transaction
      if (timer) clearTimeout(timer);
      abort?.abort();
      seq++;
      if (shown) {
        record(shown.kind, true, true, "dismissed", shown.latencyMs);
        shown = null;
      }
      const mySeq = seq;
      // We are inside the editor's transaction cycle here (onChange fires during
      // updateState). Dispatching another transaction synchronously re-enters
      // rendering and trips "Maximum update depth exceeded", so defer it.
      defer(() => {
        if (mySeq === seq) clearSuggestion(view());
      });
      timer = setTimeout(() => void run(mySeq), AI.timing.actionDebounceMs);
    };

    const unsubChange = editor.onChange((_ed, { getChanges }) => {
      try {
        for (const c of getChanges() as Array<{ block?: { id?: string } }>) {
          if (c.block?.id) recentIds.add(c.block.id);
        }
      } catch {
        // change introspection is best-effort; recency is only a prompt hint
      }
      schedule();
    }, false);
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
