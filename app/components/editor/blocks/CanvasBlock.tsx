"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { ySyncPluginKey } from "y-prosemirror";
import type * as Y from "yjs";
import { flattenBlocks, type AnyBlock } from "@/app/lib/ai/projection";
import { useHints } from "@/app/components/hints/useHints";
import { useReadOnly } from "../readOnly";
import { CanvasAiContext } from "../canvas/canvasAi";
import { CanvasCollab } from "../canvas/collab/binding";
import {
  broadcastCanvasPresence,
  paintCanvasPresence,
} from "../canvas/collab/presence";
import {
  canvasMapName,
  hasCanvasState,
  materializeCanvas,
} from "../canvas/collab/ymap";
import { providerForDoc } from "@/app/lib/sync/YConvexProvider";
import { serializeScene } from "../canvas/scene/serialize";
import { CanvasSurface, type CanvasApi } from "../canvas/render/CanvasSurface";
import { useCanvasShell } from "../canvas/shell";

/** How many preceding blocks of page text to hand the canvas for context. */
const CONTEXT_BLOCKS = 4;

/** The one editor member this block needs beyond what the spec hands over. */
type HostEditor = {
  prosemirrorState: unknown;
  getExtension: (key: string) => unknown;
};

/**
 * The Y.Doc this editor is currently bound to — the fork's while a review is
 * open, the shared one otherwise — or null on the legacy pipeline, where the
 * block prop remains the whole story.
 */
function currentYDoc(editor: HostEditor): Y.Doc | null {
  try {
    const state = ySyncPluginKey.getState(
      editor.prosemirrorState as Parameters<typeof ySyncPluginKey.getState>[0],
    ) as { doc?: Y.Doc; type?: { doc?: Y.Doc | null } } | undefined;
    return state?.doc ?? state?.type?.doc ?? null;
  } catch {
    return null;
  }
}

function CanvasBlockView({
  blockId,
  source,
  onChange,
  editor,
  getDocContext,
}: {
  blockId: string;
  source: string;
  onChange: (source: string) => void;
  editor: HostEditor;
  /** Surrounding page text, used to inform shape-label completion. */
  getDocContext: () => string;
}) {
  const shell = useCanvasShell();
  const readOnly = useReadOnly();
  const mine = shell.active?.blockId === blockId;
  const api = useRef<CanvasApi | null>(null);
  const [liveApi, setLiveApi] = useState<CanvasApi | null>(null);

  // ---- CRDT binding (Yjs pipeline only) ----------------------------------
  // The maps are the truth and the block prop is a mirror; see
  // canvas/collab/binding.ts for the whole story. Re-derives the doc when a
  // review forks the editor, so an AI's canvas preview stays private too.
  const collab = useMemo(() => new CanvasCollab(blockId), [blockId]);
  const [forkNonce, setForkNonce] = useState(0);
  useEffect(() => {
    const fork = editor.getExtension("yForkDoc") as
      | { store?: { subscribe: (cb: () => void) => () => void } }
      | undefined;
    if (!fork?.store?.subscribe) return;
    return fork.store.subscribe(() => setForkNonce((n) => n + 1));
  }, [editor]);
  const yDoc = useMemo(
    () => currentYDoc(editor),
    // The nonce is the re-derive trigger: a fork swap replaces the plugins
    // underneath the same editor object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, forkNonce],
  );

  // What the surface's store is born with: the maps when they hold the
  // diagram, else the prop. Pure read; StrictMode may run it twice, harmlessly.
  const [seed] = useState(() => {
    if (yDoc) {
      const root = yDoc.getMap<unknown>(canvasMapName(blockId));
      if (hasCanvasState(root)) return serializeScene(materializeCanvas(root));
    }
    return source;
  });

  const sourceRef = useRef(source);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    sourceRef.current = source;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!yDoc) return;
    collab.attach(yDoc, sourceRef.current);
    return () => collab.detach();
  }, [collab, yDoc]);

  // A prop change nobody here mirrored: a collaborator's mirror (a no-op once
  // their map writes arrived) or the AI writing a whole diagram.
  useEffect(() => {
    if (!yDoc || !collab.attached) return;
    if (source !== collab.lastMirrored) collab.adoptExternal(source);
  }, [collab, yDoc, source]);

  /** Local flushes go to the maps AND to the prop — the mirror. */
  const collabChange = useCallback(
    (html: string) => {
      collab.writeLocal(html);
      onChangeRef.current(html);
    },
    [collab],
  );

  // Everyone paints co-presence (leaves, selections, live drags); a forked
  // doc has no provider, so a review's private canvas shows nobody and tells
  // nobody — exactly the fork's contract.
  useEffect(() => {
    if (!liveApi || !yDoc) return;
    const provider = providerForDoc(yDoc);
    if (!provider) return;
    return paintCanvasPresence(
      provider.awareness,
      provider.doc.clientID,
      blockId,
      liveApi,
    );
  }, [liveApi, yDoc, blockId]);

  // Only the person actually ON the diagram broadcasts — the leaf is
  // attention, not an open tab.
  useEffect(() => {
    if (!mine || !liveApi || !yDoc) return;
    const provider = providerForDoc(yDoc);
    if (!provider) return;
    return broadcastCanvasPresence(provider.awareness, blockId, liveApi);
  }, [mine, liveApi, yDoc, blockId]);

  const surfaceSource = yDoc ? seed : source;
  const surfaceChange = yDoc ? collabChange : onChange;

  /**
   * The first-touch lesson: this is an editor, not a picture. Shown only over
   * a diagram with something on it — an empty canvas already explains itself —
   * and retired the first time a shape actually moves.
   */
  const hints = useHints();
  const hinted = hints.alive("canvas") && Boolean(source.trim());
  useEffect(() => {
    if (!hinted || !mine || !liveApi) return;
    const store = liveApi.store;
    const entered = store.getScene();
    const opened = performance.now();
    // Identity, not equality: ops return the same objects for parts they did
    // not touch, so a new scene object IS an edit. The grace window covers the
    // reflow entering a canvas can cause on its own.
    return store.subscribe(() => {
      if (performance.now() - opened > 500 && store.getScene() !== entered) {
        hints.die("canvas");
      }
    });
  }, [hinted, mine, liveApi, hints]);

  // Keep the context value referentially stable. The block spec passes a fresh
  // closure on every render, and a changing context value would re-render every
  // shape on each editor update.
  const context = useRef(getDocContext);
  useEffect(() => {
    context.current = getDocContext;
  });
  const ai = useMemo(() => ({ getDocContext: () => context.current() }), []);

  // Not on mount: a page can hold several diagrams, and none of them should
  // take the screen's panels for being on it. Claimed on the way DOWN, and on
  // pointer rather than focus — the block is a void node, so ProseMirror keeps
  // the selection and the focus the canvas would otherwise be waiting for.
  const claim = () => {
    if (!mine && api.current) shell.set({ blockId, api: api.current });
  };

  if (readOnly) {
    // The surface's own view-only mode: pan and zoom stay whole, every path
    // that could touch the scene is off, and the shell is never claimed. The
    // api is still captured so remote edits keep flowing into the store.
    return (
      <div className="relative w-full">
        <CanvasAiContext value={ai}>
          <CanvasSurface
            source={surfaceSource}
            onChange={() => {}}
            readOnly
            // Captured so remote edits flow in and co-presence paints; a
            // viewer never claims the shell, so they never broadcast.
            onApi={(next) => {
              setLiveApi(next);
              collab.setStore(next?.store ?? null);
            }}
          />
        </CanvasAiContext>
      </div>
    );
  }

  return (
    // `w-full` is load-bearing: BlockNote lays a block's content out with flex,
    // so this wrapper is a flex item and would otherwise shrink to nothing —
    // the canvas sizes itself against it, and everything inside the canvas is
    // absolutely positioned, so there is no content to hold it open.
    <div className="relative w-full" onPointerDownCapture={claim} onFocus={claim}>
      <CanvasAiContext value={ai}>
        <CanvasSurface
          source={surfaceSource}
          onChange={surfaceChange}
          // Republished on every tool change, and withdrawn on unmount; either
          // way it speaks for this block only while this block holds the shell.
          onApi={(next) => {
            api.current = next;
            setLiveApi(next);
            collab.setStore(next?.store ?? null);
            if (mine) shell.set(next ? { blockId, api: next } : null);
          }}
        />
      </CanvasAiContext>
      {hinted && (
        <p className="nt-canvas-hint is-low" aria-hidden>
          A real canvas, not a picture — click in and drag a shape
        </p>
      )}
    </div>
  );
}

export const canvasBlockSpec = createReactBlockSpec(
  {
    type: "canvas",
    propSchema: { data: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <CanvasBlockView
        blockId={block.id}
        source={block.props.data}
        onChange={(data) => editor.updateBlock(block.id, { props: { data } })}
        editor={editor as unknown as HostEditor}
        // Text just above the diagram, so completing a shape label can draw on
        // what the page is actually about.
        getDocContext={() => {
          const flat = flattenBlocks(editor.document as unknown as AnyBlock[]);
          const idx = flat.findIndex((b) => b.id === block.id);
          if (idx <= 0) return "";
          return flat
            .slice(Math.max(0, idx - CONTEXT_BLOCKS), idx)
            .map((b) => b.text.trim())
            .filter(Boolean)
            .join("\n");
        }}
      />
    ),
  },
)();
