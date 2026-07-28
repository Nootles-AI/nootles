"use client";

import { useCallback, useMemo, useState } from "react";
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

/**
 * Dev-only harness that proves the AI substrate WITHOUT any model: author an op
 * batch as JSON → validate → apply to the live editor, watch the projection
 * update, and snapshot / restore checkpoints. This is the gate the substrate has
 * to pass before an LLM is wired in (the model will just produce the same batch
 * JSON this panel lets you hand-author).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPartialBlock = PartialBlock<any, any, any>;

const EXAMPLE = `{
  "ops": [
    { "kind": "insertBlocks", "at": { "at": "docEnd" }, "blocks": [
      { "tempId": "h", "type": "heading", "props": { "level": 2 },
        "content": [{ "type": "text", "text": "AI substrate demo" }] },
      { "tempId": "p", "type": "paragraph", "content": [
        { "type": "text", "text": "Energy " },
        { "type": "math", "latex": "E=mc^2" },
        { "type": "text", "text": " is famous.", "marks": ["italic"] }
      ] },
      { "tempId": "code", "type": "codeBlock",
        "props": { "language": "typescript", "code": "const x = 42;" } },
      { "tempId": "math", "type": "mathBlock",
        "props": { "source": "a = 3\\nb = 4\\nc = a + b" } },
      { "tempId": "cv", "type": "canvas" }
    ] },
    { "kind": "addShape", "blockId": "cv", "tempId": "s1", "shape": "rectangle",
      "position": { "x": 40, "y": 60 }, "label": "Start" },
    { "kind": "addShape", "blockId": "cv", "tempId": "s2", "shape": "diamond",
      "position": { "x": 280, "y": 60 }, "label": "Decision" },
    { "kind": "connectEdge", "blockId": "cv", "tempId": "e1",
      "source": { "tempId": "s1" }, "target": { "tempId": "s2" }, "label": "go" }
  ]
}`;

export function SubstrateHarness({
  editor,
  pageId,
}: {
  editor: Editor;
  pageId: Id<"pages">;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(EXAMPLE);
  const [log, setLog] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tick, setTick] = useState(0);
  /** Null while mirroring the live document; a string once you start editing. */
  const [htmlDraft, setHtmlDraft] = useState<string | null>(null);

  const appendBatch = useMutation(api.ai.opLog.appendBatch);
  const createCheckpoint = useMutation(api.ai.checkpoints.create);
  const checkpoints = useQuery(api.ai.checkpoints.list, { pageId });

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const projection = useMemo(() => {
    void tick; // recompute when we bump the tick after a mutation
    try {
      return project(editor.document as unknown as AnyBlock[]).text;
    } catch (e) {
      return `projection error: ${String(e)}`;
    }
  }, [editor, tick]);

  const parseInput = (): unknown | null => {
    try {
      return JSON.parse(text);
    } catch (e) {
      setLog({ ok: false, msg: `JSON parse error: ${String(e)}` });
      return null;
    }
  };

  const onValidate = () => {
    const input = parseInput();
    if (input === null) return;
    const index = project(editor.document as unknown as AnyBlock[]).index;
    const res = resolveBatch(input, index);
    setLog(
      res.ok
        ? { ok: true, msg: `Valid — ${res.batch.ops.length} op(s) ready.` }
        : { ok: false, msg: `Rejected:\n- ${res.errors.join("\n- ")}` },
    );
  };

  const onApply = async () => {
    const input = parseInput();
    if (input === null) return;
    const index = project(editor.document as unknown as AnyBlock[]).index;
    const res = resolveBatch(input, index);
    if (!res.ok) {
      setLog({ ok: false, msg: `Rejected (nothing applied):\n- ${res.errors.join("\n- ")}` });
      return;
    }
    const chatPromptId = crypto.randomUUID();
    // Checkpoint before mutating, so a bad batch is one restore away.
    await createCheckpoint({
      pageId,
      chatPromptId,
      docSnapshot: editor.document,
    });
    const result = applyBatch(editor, res.batch);
    await appendBatch({
      pageId,
      chatPromptId,
      source: "ai",
      ops: res.batch.ops,
    });
    refresh();
    setLog({
      ok: true,
      msg: `Applied ${res.batch.ops.length} op(s). Minted ids: ${JSON.stringify(result)}`,
    });
  };

  // The document in the auto-board HTML language — what the model reads and
  // writes. Editing it here exercises the whole path: parse → compile → validate
  // → apply, which is exactly what a completion will do.
  const currentHtml = useMemo(() => {
    void tick;
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
      const anchorBlockId = doc[doc.length - 1]?.id ?? "";
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
      await createCheckpoint({ pageId, chatPromptId, docSnapshot: editor.document });
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
      docSnapshot: editor.document,
    });
    setLog({ ok: true, msg: "Checkpoint saved." });
  };

  const onRestore = (snapshot: unknown) => {
    editor.replaceBlocks(
      editor.document,
      snapshot as AnyPartialBlock[],
    );
    refresh();
    setLog({ ok: true, msg: "Restored to checkpoint." });
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted shadow-sm hover:text-foreground"
        title="AI substrate harness (dev)"
      >
        substrate
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-[80vh] w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
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
        <label className="font-medium text-muted">Op batch (JSON)</label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="h-48 w-full resize-y rounded border border-border bg-surface p-2 font-mono text-[11px] leading-snug outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <HarnessBtn onClick={onValidate}>Validate</HarnessBtn>
          <HarnessBtn onClick={onApply} primary>
            Apply
          </HarnessBtn>
          <HarnessBtn onClick={onSnapshot}>Snapshot</HarnessBtn>
          <HarnessBtn onClick={() => setText(EXAMPLE)}>Reset example</HarnessBtn>
          <HarnessBtn onClick={refresh}>Refresh projection</HarnessBtn>
        </div>

        {log && (
          <pre
            className={`whitespace-pre-wrap rounded border p-2 text-[11px] ${
              log.ok
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {log.msg}
          </pre>
        )}

        <label className="mt-1 flex items-center justify-between font-medium text-muted">
          <span>
            Document HTML{" "}
            {htmlDraft !== null && (
              <span className="font-normal text-[10px] text-amber-700">(edited)</span>
            )}
          </span>
          <span className="font-normal text-[10px]">
            id present → update · absent → insert
          </span>
        </label>
        <textarea
          value={htmlValue}
          onChange={(e) => setHtmlDraft(e.target.value)}
          spellCheck={false}
          className="h-56 w-full resize-y rounded border border-border bg-surface p-2 font-mono text-[11px] leading-snug outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <HarnessBtn onClick={onApplyHtml} primary>
            Apply HTML
          </HarnessBtn>
          <HarnessBtn onClick={() => setHtmlDraft(null)}>Reload from doc</HarnessBtn>
        </div>

        <label className="mt-1 font-medium text-muted">Projection (legacy)</label>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 font-mono text-[11px] leading-snug">
          {projection || "(empty document)"}
        </pre>

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
                  {new Date(c.createdAt).toLocaleTimeString()} · {c.chatPromptId.slice(0, 8)}
                </span>
                <button
                  onClick={() => onRestore(c.docSnapshot)}
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
