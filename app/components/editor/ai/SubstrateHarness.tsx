"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { project, type AnyBlock } from "@/app/lib/ai/projection";
import { resolveBatch } from "@/app/lib/ai/validate";
import { applyBatch } from "@/app/lib/ai/apply";
import { toDocHtml } from "@/app/lib/ai/html/serialize";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { compileDocHtml } from "@/app/lib/ai/html/compile";
import { packTurn, unpackTurn } from "@/app/lib/ai/review/pack";

/**
 * Dev-only harness for the AI substrate, with no model involved.
 *
 * The document is shown in the Nootles HTML language — the one surface the
 * AI reads and writes — and the pane is editable, so an edit runs exactly the
 * path a completion takes: parse → compile → validate → apply.
 *
 * Ops are deliberately an OUTPUT only. They're the intermediate representation
 * everything compiles down to, not an authoring surface, so there's no way to
 * hand-write them here — that would imply a second modality that doesn't exist.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPartialBlock = PartialBlock<any, any, any>;

export function SubstrateHarness({
  editor,
  pageId,
}: {
  editor: Editor;
  pageId: Id<"pages">;
}) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tick, setTick] = useState(0);
  /** Null while mirroring the live document; a string once you start editing. */
  const [htmlDraft, setHtmlDraft] = useState<string | null>(null);

  const appendBatch = useMutation(api.ai.opLog.appendBatch);
  const createCheckpoint = useMutation(api.ai.checkpoints.create);
  const checkpoints = useQuery(api.ai.checkpoints.list, { pageId });

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  /**
   * Mirror the live document. `editor` is a stable reference and `tick` only
   * moved on a button press, so the pane silently went stale the moment you
   * typed — it was showing whatever the doc looked like when it was opened.
   *
   * Only while the pane is open (this is dev-only, but typing must stay O(1)
   * when it isn't) and only while you have not started editing, so a draft is
   * never clobbered mid-edit. Coalesced on a frame so a burst of keystrokes
   * costs one re-serialize.
   */
  useEffect(() => {
    if (!open || htmlDraft !== null) return;
    let queued: ReturnType<typeof setTimeout> | null = null;
    const unsub = editor.onChange(() => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        refresh();
      }, 120);
    }, false);
    return () => {
      if (queued) clearTimeout(queued);
      unsub?.();
    };
  }, [editor, open, htmlDraft, refresh]);

  const currentHtml = useMemo(() => {
    void tick; // recompute after a mutation
    try {
      return toDocHtml(editor.document as unknown as AnyBlock[]);
    } catch (e) {
      return `serialize error: ${String(e)}`;
    }
  }, [editor, tick]);

  const htmlValue = htmlDraft ?? currentHtml;

  const onApplyHtml = async () => {
    try {
      const current = parseDocHtml(currentHtml);
      const next = parseDocHtml(htmlValue);
      const doc = editor.document as unknown as AnyBlock[];
      // Only a fallback: placement is normally inferred from the surrounding
      // tagged blocks. The caret is the sensible default when it can't be.
      let anchorBlockId: string | undefined;
      try {
        anchorBlockId = editor.getTextCursorPosition().block.id as string;
      } catch {
        anchorBlockId = doc[doc.length - 1]?.id;
      }
      const batch = compileDocHtml(next, { anchorBlockId, current });
      if (!batch.ops.length) {
        setLog({ ok: true, msg: "No differences — compiled to 0 ops." });
        return;
      }
      const { index } = project(doc);
      const resolved = resolveBatch(batch, index);
      if (!resolved.ok) {
        setLog({
          ok: false,
          msg: `Rejected (nothing applied):\n- ${resolved.errors.join("\n- ")}`,
        });
        return;
      }
      const chatPromptId = crypto.randomUUID();
      await createCheckpoint({
        pageId,
        chatPromptId,
        docSnapshot: await packTurn(editor.document),
      });
      applyBatch(editor, resolved.batch);
      await appendBatch({
        pageId,
        chatPromptId,
        source: "ai",
        ops: resolved.batch.ops,
      });
      setHtmlDraft(null);
      refresh();
      setLog({
        ok: true,
        msg: `Applied ${resolved.batch.ops.length} op(s):\n${JSON.stringify(
          resolved.batch.ops,
          null,
          1,
        )}`,
      });
    } catch (e) {
      setLog({ ok: false, msg: `HTML apply failed: ${String(e)}` });
    }
  };

  const onSnapshot = async () => {
    await createCheckpoint({
      pageId,
      chatPromptId: crypto.randomUUID(),
      docSnapshot: await packTurn(editor.document),
    });
    setLog({ ok: true, msg: "Checkpoint saved." });
  };

  const onRestore = (snapshot: unknown) => {
    editor.replaceBlocks(editor.document, snapshot as AnyPartialBlock[]);
    setHtmlDraft(null);
    refresh();
    setLog({ ok: true, msg: "Restored to checkpoint." });
  };

  if (!open) {
    return (
      <button
        onClick={() => {
          setHtmlDraft(null);
          refresh();
          setOpen(true);
        }}
        className="fixed bottom-4 left-4 z-50 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted shadow-sm hover:text-foreground"
        title="AI substrate harness (dev)"
      >
        substrate
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 flex max-h-[80vh] w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold tracking-tight">AI substrate harness</span>
        <button
          onClick={() => setOpen(false)}
          className="rounded p-1 text-muted hover:text-foreground"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-2 overflow-y-auto p-3 text-xs">
        <label className="flex items-center justify-between font-medium text-muted">
          <span>
            Document HTML{" "}
            {htmlDraft !== null && (
              <span className="text-[10px] font-normal text-amber-700">(edited)</span>
            )}
          </span>
          <span className="text-[10px] font-normal">
            id present → update · absent → insert
          </span>
        </label>
        <textarea
          value={htmlValue}
          onChange={(e) => setHtmlDraft(e.target.value)}
          spellCheck={false}
          className="h-72 w-full resize-y rounded border border-border bg-surface p-2 font-mono text-[11px] leading-snug outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <HarnessBtn onClick={onApplyHtml} primary>
            Apply HTML
          </HarnessBtn>
          <HarnessBtn onClick={() => setHtmlDraft(null)}>Reload from doc</HarnessBtn>
          <HarnessBtn onClick={onSnapshot}>Snapshot</HarnessBtn>
        </div>

        {log && (
          <pre
            className={`max-h-64 overflow-auto whitespace-pre-wrap rounded border p-2 text-[11px] ${
              log.ok
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {log.msg}
          </pre>
        )}

        <label className="mt-1 font-medium text-muted">
          Checkpoints ({checkpoints?.length ?? 0})
        </label>
        <div className="flex flex-col gap-1">
          {checkpoints
            ?.slice()
            .reverse()
            .map((c) => (
              <div
                key={c._id}
                className="flex items-center justify-between rounded border border-border px-2 py-1"
              >
                <span className="truncate text-muted">
                  {new Date(c.createdAt).toLocaleTimeString()} ·{" "}
                  {c.chatPromptId.slice(0, 8)}
                </span>
                <button
                  onClick={async () => onRestore(await unpackTurn(c.docSnapshot))}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-black/5"
                >
                  Restore
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function HarnessBtn({
  children,
  onClick,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-[11px] font-medium ${
        primary
          ? "bg-foreground text-background hover:opacity-90"
          : "border border-border text-foreground hover:bg-black/5"
      }`}
    >
      {children}
    </button>
  );
}
