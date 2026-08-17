"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { notFound, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useConvex } from "convex/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { schema } from "@/app/components/editor/schema";
import { arrivalFlashExtension } from "@/app/components/editor/arrivalFlash";
import { watchFimFlash } from "@/app/lib/sync/fimFlash";
import { YConvexProvider } from "@/app/lib/sync/YConvexProvider";
import "@/app/components/editor/editor.css";

/**
 * Two independent collaboration clients on one document, in one tab — the
 * deterministic way to watch convergence and cursors without arranging two
 * humans. Dev-only, behind the normal sign-in (writes need a real role), and
 * deliberately NOT using the shared provider registry: the whole point is two
 * separate Y.Docs racing each other.
 *
 * Visit /yjs-harness?docId=<docId> for a page you can edit.
 */
export default function YjsHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <Harness />
    </Suspense>
  );
}

function Harness() {
  const docId = useSearchParams().get("docId");
  if (!docId) {
    return (
      <p className="p-8 text-sm text-muted">
        Pass ?docId=&lt;a page&apos;s docId&gt;.
      </p>
    );
  }
  return (
    <div className="flex h-screen divide-x" style={{ borderColor: "var(--border)" }}>
      <Client docId={docId} label="Client A" color="#7a8a5c" />
      <Client docId={docId} label="Client B" color="#7d6f9e" />
    </div>
  );
}

function Client({
  docId,
  label,
  color,
}: {
  docId: string;
  label: string;
  color: string;
}) {
  const client = useConvex();

  const [lastId, setLastId] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  const [provider, setProvider] = useState<YConvexProvider | null>(null);
  useEffect(() => {
    const p = new YConvexProvider(client, docId, new Y.Doc());
    p.connect();
    setProvider(p);
    return () => {
      setProvider(null);
      p.destroy();
      p.doc.destroy();
    };
  }, [client, docId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const synced = useSyncExternalStore(
    provider ? (cb) => provider.subscribe(cb) : () => () => {},
    () => provider?.synced ?? false,
    () => false,
  );
  const unsynced = useSyncExternalStore(
    provider ? (cb) => provider.subscribe(cb) : () => () => {},
    () => provider?.hasUnsyncedChanges ?? false,
    () => false,
  );

  const editor = useMemo(() => {
    if (!provider || !synced) return null;
    return BlockNoteEditor.create(
      withCollaboration({
        schema,
        extensions: [arrivalFlashExtension],
        collaboration: {
          fragment: provider.doc.getXmlFragment("prosemirror"),
          user: { name: label, color },
          provider: { awareness: provider.awareness },
          showCursorLabels: "always",
        },
      }),
    );
  }, [provider, synced, label, color]);

  // The same arrival-flash watcher the real editors run, so the harness can
  // exercise gold-on-first-frame without a model in the loop.
  useEffect(() => {
    if (!provider || !editor) return;
    return watchFimFlash(provider, () => {
      const holder = editor as unknown as {
        _tiptapEditor?: { view?: import("prosemirror-view").EditorView };
      };
      return holder._tiptapEditor?.view ?? null;
    });
  }, [provider, editor]);

  const announce = (ids: string[]) => {
    if (!provider) return;
    provider.doc.transact(() => {
      provider.doc
        .getMap<{ ids: string[]; n: number; by: number }>("nt:flash")
        .set("last", { ids, n: Date.now(), by: provider.doc.clientID });
    });
  };

  /**
   * A model-free stand-in for an AI accept: the flash marker and the new
   * block written in ONE task, exactly as the real accept paths do — which
   * is the property (one flush, marker-first arming) under test.
   */
  const simulateAccept = () => {
    if (!provider || !editor) return;
    const id = crypto.randomUUID();
    announce([id]);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks(
      [{ id, type: "paragraph", content: `SIMULATED-${id.slice(0, 8)}` }],
      last ?? editor.document[0],
      "after",
    );
    setLastId(id);
  };

  /** The ghost-accept shape: more ink into a block the peer already shows. */
  const simulateAgain = () => {
    if (!provider || !editor || !lastId || !editor.getBlock(lastId)) return;
    announce([lastId]);
    editor.updateBlock(lastId, {
      content: `SIMULATED-AGAIN-${Date.now() % 100000}`,
    });
  };

  /** A whole diagram arriving — the outline flash and shape-veil treatment. */
  const simulateCanvas = () => {
    if (!provider || !editor) return;
    const id = crypto.randomUUID();
    announce([id]);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks(
      [{ id, type: "canvas" }],
      last ?? editor.document[0],
      "after",
    );
  };

  /** A code block arriving — ink the cascade can't reach, so the frame flashes. */
  const simulateCode = () => {
    if (!provider || !editor) return;
    const id = crypto.randomUUID();
    announce([id]);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks(
      [{ id, type: "codeBlock", props: { code: `// SIMULATED-${id.slice(0, 8)}` } }],
      last ?? editor.document[0],
      "after",
    );
  };

  /** The agent-approval shape: one marker naming a whole turn's blocks. */
  const simulateBurst = () => {
    if (!provider || !editor) return;
    const blocks = Array.from({ length: 24 }, (_, i) => {
      const id = crypto.randomUUID();
      return {
        id,
        type: "paragraph" as const,
        content: `SIMULATED-BURST-${i}-${id.slice(0, 8)}`,
      };
    });
    announce(blocks.map((b) => b.id));
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks(blocks, last ?? editor.document[0], "after");
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col" data-harness={label}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4 text-[13px]" style={{ borderColor: "var(--border)" }}>
        <span className="font-medium" style={{ color }}>
          {label}
        </span>
        <span className="text-muted" data-status>
          {!synced ? "syncing…" : unsynced ? "unsent edits" : "synced"}
        </span>
        <button
          className="nt-row ml-auto px-2 text-muted"
          data-simulate
          onClick={simulateAccept}
        >
          Simulate AI accept
        </button>
        <button
          className="nt-row px-2 text-muted disabled:opacity-40"
          data-simulate-again
          onClick={simulateAgain}
          disabled={!lastId}
        >
          Same block again
        </button>
        <button
          className="nt-row px-2 text-muted"
          data-simulate-canvas
          onClick={simulateCanvas}
        >
          Canvas accept
        </button>
        <button
          className="nt-row px-2 text-muted"
          data-simulate-code
          onClick={simulateCode}
        >
          Code accept
        </button>
        <button
          className="nt-row px-2 text-muted"
          data-simulate-burst
          onClick={simulateBurst}
        >
          Burst
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {editor ? (
          <BlockNoteView
            editor={editor}
            theme="light"
            className="nt-editor"
            sideMenu={false}
            slashMenu={false}
            formattingToolbar={false}
          />
        ) : (
          <div className="nt-skeleton h-4 w-1/2" />
        )}
      </div>
    </section>
  );
}
