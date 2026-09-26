"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { useConvex } from "convex/react";
import { ySyncPluginKey } from "y-prosemirror";
import type * as Y from "yjs";
import { flattenBlocks, type AnyBlock } from "@/app/lib/ai/projection";
import { useHints } from "@/app/components/hints/useHints";
import { useReadOnly } from "../readOnly";
import { putDataUri } from "../album/upload";
import { canonicalPathOps } from "../canvas/scene/canonicalPaths";
import { hoistOps, inlinePictures } from "../canvas/scene/inlineImages";
import { CanvasAiContext } from "../canvas/canvasAi";
import { CANVAS_MIRROR_META, CanvasCollab, onDiagramSettle } from "../canvas/collab/binding";
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
import { useCanvasUndoDomain } from "@/app/lib/history/canvasDomain";
import { registerSurface } from "@/app/lib/history/surfaceRegistry";
import { useWorkspaceHistory } from "@/app/lib/history/useWorkspaceHistory";
import { useCurrentPage } from "@/app/components/OpenPageContext";
import { effectiveScale } from "@/app/lib/columnScale";
import { peekSceneStore, sceneStoreKey } from "../canvas/engine/useScene";
import { serializeScene } from "../canvas/scene/serialize";
import type { Scene } from "../canvas/scene/types";
import { CanvasSurface, type CanvasApi } from "../canvas/render/CanvasSurface";
import { usePageCanvas } from "../canvas/page/PageCanvas";

/** How many preceding blocks of page text to hand the canvas for context. */
const CONTEXT_BLOCKS = 4;

/**
 * How long the block-prop mirror trails the maps while a diagram is being
 * edited.
 *
 * The maps carry the edit itself, per shape; the prop carries the whole
 * serialized diagram, and putting that into the page's update log on the
 * store's own 500ms cadence writes a copy of the drawing per edit pause. The
 * mirror is display-grade by contract (see `canvas/collab/binding.ts`), so it
 * waits — and lands early whenever the diagram's selection is let go, or the
 * tab is.
 */
const MIRROR_MS = 5000;

/** The editor members this block needs beyond what the spec hands over. */
type HostEditor = {
  prosemirrorState: unknown;
  getExtension: (key: string) => unknown;
  getBlock: (id: string) => { props?: unknown } | undefined;
  removeBlocks: (ids: string[]) => unknown;
};

type ForkStore = {
  state?: { isForked?: boolean };
  subscribe?: (cb: () => void) => () => void;
};

const NEVER_CHANGES = () => () => {};

/**
 * Keeps a band on the text column however deep its block is nested: BlockNote
 * indents a child block's content, and a band's origin is the text's edge,
 * not the indent's. Written to the element — the indent is layout, not state —
 * and read again whenever the block content or the editor changes width,
 * which is what an indent or an outdent does.
 */
function useColumnAnchor(): RefObject<HTMLDivElement | null> {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    const content = el?.closest<HTMLElement>(".bn-block-content");
    const root = el?.closest<HTMLElement>(".bn-editor");
    if (!el || !content || !root) return;
    const anchor = () => {
      const visual = content.getBoundingClientRect().left - root.getBoundingClientRect().left;
      const indent = Math.round(visual / effectiveScale(el));
      el.style.marginLeft = indent ? `${-indent}px` : "";
      el.style.width = indent ? `calc(100% + ${indent}px)` : "";
    };
    anchor();
    const observer = new ResizeObserver(anchor);
    observer.observe(content);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return host;
}

const forkStore = (editor: HostEditor) =>
  (editor.getExtension("yForkDoc") as { store?: ForkStore } | undefined)?.store;

/**
 * The Y.Doc this editor is currently bound to — the fork's while a review is
 * open, the shared one otherwise — or null on the legacy pipeline, where the
 * block prop remains the whole story. Read off the binding: ProseMirror keeps a
 * plugin's state field across the fork's plugin swap, so the sync state's own
 * `doc` names the shared doc throughout, and a canvas bound through it wrote a
 * review's preview where every collaborator could see it (NT-43).
 */
function currentYDoc(editor: HostEditor): Y.Doc | null {
  try {
    const state = ySyncPluginKey.getState(
      editor.prosemirrorState as Parameters<typeof ySyncPluginKey.getState>[0],
    ) as { binding?: { doc?: Y.Doc } } | undefined;
    return state?.binding?.doc ?? null;
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
  /** `mirror` marks a write that describes the maps rather than an edit. */
  onChange: (source: string, mirror?: boolean) => void;
  editor: HostEditor;
  /** Surrounding page text, used to inform shape-label completion. */
  getDocContext: () => string;
}) {
  const page = usePageCanvas();
  const readOnly = useReadOnly();
  const api = useRef<CanvasApi | null>(null);
  const [liveApi, setLiveApi] = useState<CanvasApi | null>(null);
  const host = useColumnAnchor();
  // The diagram holds a selection of its own: the moment its first-touch
  // lesson is an answer rather than a caption.
  const selection = liveApi?.selection;
  const engaged = useSyncExternalStore(
    selection?.subscribe ?? NEVER_CHANGES,
    () => {
      const snapshot = selection?.getSnapshot();
      return !!snapshot && (snapshot.ids.length > 0 || snapshot.edgeIds.length > 0);
    },
    () => false,
  );

  // ---- CRDT binding (Yjs pipeline only) ----------------------------------
  // The maps are the truth and the block prop is a mirror; see
  // canvas/collab/binding.ts for the whole story. Re-derives the doc when a
  // review forks the editor, so an AI's canvas preview stays private too.
  const collab = useMemo(() => new CanvasCollab(blockId), [blockId]);
  const [forkNonce, setForkNonce] = useState(0);
  useEffect(() => {
    const store = forkStore(editor);
    if (!store?.subscribe) return;
    return store.subscribe(() => setForkNonce((n) => n + 1));
  }, [editor]);
  const [yDoc, forked] = useMemo(
    () => [currentYDoc(editor), forkStore(editor)?.state?.isForked === true] as const,
    // The nonce is the re-derive trigger: a fork swap replaces the plugins
    // underneath the same editor object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, forkNonce],
  );

  // What the surface's store is born with: a warm store's own knowledge when
  // one survived a page switch (so reviving it reads as no change at all),
  // else the maps when they hold the diagram, else the prop. Pure read;
  // StrictMode may run it twice, harmlessly.
  const [seed] = useState(() => {
    const held = peekSceneStore(sceneStoreKey(blockId));
    if (held) return held.seedSource();
    if (yDoc) {
      const root = yDoc.getMap<unknown>(canvasMapName(blockId));
      if (hasCanvasState(root)) return serializeScene(materializeCanvas(root));
    }
    return source;
  });

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  /** The mirror waiting to be written, and the timer that will write it. */
  const mirror = useRef<{
    html: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /**
   * The mirror last written, until a render carries it. A flush landing in
   * between moves `lastMirrored` on, and on a fork, where every other prop
   * change is an author, our own write read back late would be adopted over
   * the newer edit.
   */
  const written = useRef<string | null>(null);

  const writeMirror = useCallback(() => {
    const held = mirror.current;
    if (!held) return;
    clearTimeout(held.timer);
    mirror.current = null;
    // Marked in the same task, so a collaborator can tell this mirror from an
    // outside author however far behind the maps it lands; and taken from the
    // maps as they are now, not as they were when it was asked for.
    const html = collab.stampMirror(held.html);
    written.current = html;
    try {
      onChangeRef.current(html, true);
    } catch {
      // The block can be gone by the time the mirror lands — a delete, or the
      // page it was on being closed. The maps still hold the diagram.
    }
  }, [collab]);

  const dropMirror = useCallback(() => {
    if (!mirror.current) return;
    clearTimeout(mirror.current.timer);
    mirror.current = null;
  }, []);

  // Ahead of the binding's effect below, and the order is load-bearing: an
  // unmount runs cleanups in declaration order, and the last mirror has to be
  // marked while the binding is still attached to the doc it is going into.
  useEffect(() => () => writeMirror(), [writeMirror]);

  /** The prop as this block last reconciled it — what a rebind hands the new doc. */
  const seen = useRef(source);

  useEffect(() => {
    if (!yDoc) return;
    // Leaving a fork with a mirror still waiting means the fork was dropped —
    // one that lands writes its mirror first (below) — and the mirror
    // describes a diagram that went with it.
    if (!forked) dropMirror();
    collab.attach(yDoc, seen.current, forked);
    return () => collab.detach();
  }, [collab, yDoc, forked, dropMirror]);

  /** The last prop from outside this canvas that this block has taken in. */
  const outsideSeen = useRef(source);

  /**
   * A prop this block has not reconciled yet. Unless it is our own mirror, it
   * is a collaborator's mirror (a no-op once their map writes arrived), the AI
   * writing a whole diagram, or a review answering. Ours in waiting predates
   * theirs, and writing it after would put the diagram back.
   */
  const reconcile = useCallback(
    (next: string, authored?: boolean) => {
      seen.current = next;
      const ours = next === collab.lastMirrored || next === written.current;
      written.current = null;
      if (ours) return;
      dropMirror();
      outsideSeen.current = next;
      collab.adoptExternal(next, authored);
    },
    [collab, dropMirror],
  );

  useEffect(() => {
    if (!yDoc || !collab.attached || source === seen.current) return;
    reconcile(source);
  }, [collab, yDoc, source, reconcile]);

  // Asked for by a review that writes the page and, in the same task, lands its
  // fork or ends the doc's history — both ahead of the render that would run
  // the effect above. This block's own work goes onto the prop to travel with
  // it, and a prop it has not reconciled yet is the review's, adopted as such.
  useEffect(() => {
    if (!yDoc) return;
    return onDiagramSettle(yDoc, () => {
      api.current?.store.flush();
      const props = editor.getBlock(blockId)?.props as { data?: unknown } | undefined;
      if (typeof props?.data !== "string") return;
      if (props.data === seen.current) writeMirror();
      else reconcile(props.data, true);
    });
  }, [yDoc, editor, blockId, writeMirror, reconcile]);

  // The legacy pipeline's equivalent: the prop is the document, and a change
  // this block did not write is one from outside.
  const ownWrite = useRef<string | null>(null);
  const legacyChange = useCallback(
    (html: string) => {
      ownWrite.current = html;
      onChange(html);
    },
    [onChange],
  );
  useEffect(() => {
    if (yDoc) return;
    if (source === ownWrite.current || source === outsideSeen.current) return;
    outsideSeen.current = source;
  }, [yDoc, source]);

  /** The prop mirror, written once the diagram has been quiet for MIRROR_MS. */
  const scheduleMirror = useCallback(
    (html: string) => {
      if (mirror.current) clearTimeout(mirror.current.timer);
      mirror.current = { html, timer: setTimeout(writeMirror, MIRROR_MS) };
    },
    [writeMirror],
  );

  /** Local flushes go to the maps at once; the prop mirror follows behind. */
  const collabChange = useCallback(
    (html: string, scene: Scene) => {
      collab.writeLocal(html, scene);
      scheduleMirror(html);
    },
    [collab, scheduleMirror],
  );

  // A collaborator's edit that lands after this client's mirror went onto the
  // block leaves the block behind the maps, and this client is the one to bring
  // it up to date, on the same cadence as its own edits.
  useEffect(() => collab.onStaleMirror(scheduleMirror), [collab, scheduleMirror]);

  // Letting the diagram's selection go, hiding the tab, and unmounting are all
  // moments a reader of the prop — a thumbnail, `read_page`, a copy — may
  // come next.
  useEffect(() => {
    if (!engaged) writeMirror();
  }, [engaged, writeMirror]);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") writeMirror();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [writeMirror]);

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
  // attention, not an open tab. The awareness field names one diagram, so on
  // a page that is the one holding the page's focus. A press that brings the
  // selection here is under way before the selection is, and the broadcaster
  // has to be up in the press's capture to stream the drag it starts.
  const focused = useSyncExternalStore(
    page.selection.subscribe,
    () => page.selection.getSnapshot().focused === blockId,
    () => false,
  );
  const [pressing, setPressing] = useState(false);
  useEffect(() => {
    if (!pressing) return;
    const release = () => setPressing(false);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, [pressing]);
  const broadcasting = pressing || (page.pane ? focused : engaged);
  useEffect(() => {
    if (!broadcasting || !liveApi || !yDoc) return;
    const provider = providerForDoc(yDoc);
    if (!provider) return;
    return broadcastCanvasPresence(provider.awareness, blockId, liveApi);
  }, [broadcasting, liveApi, yDoc, blockId]);

  const surfaceSource = yDoc ? seed : source;
  const surfaceChange = yDoc ? collabChange : legacyChange;
  const convex = useConvex();
  // The string of record is kept honest here, without a history entry, the
  // moment anything lands on this canvas — a paste from Figma, an AI write, a
  // board saved before this existed. Two normalisations: a picture's bytes
  // move into storage and the shape is re-addressed by URL, and a path at
  // double precision is rewritten the way the pen tool writes one. One upload
  // per picture, whatever the outcome — the URL is kept, so a scene the
  // collaboration binding re-adopts from the document is re-addressed from
  // memory, and a picture that will not decode is not asked for again.
  const pictures = useRef<Map<string, string | null>>(new Map());
  const canonical = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (readOnly || !liveApi) return;
    const store = liveApi.store;
    const readdress = () => {
      const known = new Map(
        [...pictures.current].filter((entry): entry is [string, string] => !!entry[1]),
      );
      if (known.size) store.amend(hoistOps(store.getScene().nodes, known));
    };
    const hoist = () => {
      const rounding = canonicalPathOps(store.getScene().nodes, canonical.current);
      if (rounding.length) store.amend(rounding);
      readdress();
      const pending = inlinePictures(store.getScene().nodes).filter(
        (uri) => !pictures.current.has(uri),
      );
      if (!pending.length) return;
      for (const uri of pending) pictures.current.set(uri, null);
      void Promise.all(
        pending.map(async (uri) => {
          try {
            pictures.current.set(uri, await putDataUri(convex, uri));
          } catch (error) {
            console.warn("[canvas] inline picture kept inline:", error);
          }
        }),
      ).then(readdress);
    };
    hoist();
    return store.subscribe(hoist);
  }, [readOnly, liveApi, convex]);

  /**
   * The first-touch lesson: this is an editor, not a picture. Shown only over
   * a diagram with something on it — an empty canvas already explains itself —
   * once one of its shapes is in hand, and retired the first time a shape
   * actually moves.
   */
  const hints = useHints();
  const hinted = hints.alive("canvas") && Boolean(source.trim());
  useEffect(() => {
    if (!hinted || !engaged || !liveApi) return;
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
  }, [hinted, engaged, liveApi, hints]);

  // Keep the context value referentially stable. The block spec passes a fresh
  // closure on every render, and a changing context value would re-render every
  // shape on each editor update.
  const context = useRef(getDocContext);
  useEffect(() => {
    context.current = getDocContext;
  });
  const ai = useMemo(() => ({ getDocContext: () => context.current() }), []);

  // The workspace history spine: this diagram is one undo domain, and the
  // surface registry is how a focus restore finds it — after navigating back
  // to this page, if that is where the undo led.
  const spine = useWorkspaceHistory();
  const pageId = useCurrentPage();
  useCanvasUndoDomain(spine, liveApi?.store ?? null, blockId, pageId);
  useEffect(() => {
    if (readOnly) return;
    return registerSurface(blockId, () => page.focus(blockId));
  }, [page, blockId, readOnly]);

  // One of the page's diagrams, for as long as its surface is up.
  const flushMirror = useCallback(() => {
    liveApi?.store.flush();
    writeMirror();
  }, [liveApi, writeMirror]);
  const remove = useCallback(() => editor.removeBlocks([blockId]), [editor, blockId]);
  const onPage = useMemo(() => (page.pane ? { canvas: page, blockId } : undefined), [page, blockId]);
  useEffect(() => {
    if (!liveApi) return;
    return page.register({ blockId, api: liveApi, readOnly, flushMirror, remove });
  }, [page, blockId, liveApi, readOnly, flushMirror, remove]);

  if (readOnly) {
    // The surface's own view-only mode: a click still picks out one shape, and
    // everything that would move one is off. The api is still captured so
    // remote edits keep flowing into the store.
    return (
      <div ref={host} className="nt-canvas-block relative w-full">
        <CanvasAiContext value={ai}>
          <CanvasSurface
            source={surfaceSource}
            onChange={() => {}}
            storeKey={sceneStoreKey(blockId)}
            readOnly
            // Captured so remote edits flow in and co-presence paints; a
            // viewer never broadcasts.
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
    // the hint places itself against it, and a wide band is centred on it.
    <div
      ref={host}
      className="nt-canvas-block relative w-full"
      onPointerDownCapture={() => setPressing(true)}
    >
      <CanvasAiContext value={ai}>
        <CanvasSurface
          source={surfaceSource}
          onChange={surfaceChange}
          storeKey={sceneStoreKey(blockId)}
          tools={page.tools ?? undefined}
          page={onPage}
          onApi={(next) => {
            api.current = next;
            setLiveApi(next);
            collab.setStore(next?.store ?? null);
          }}
        />
      </CanvasAiContext>
      {hinted && engaged && (
        <p className="nt-canvas-hint is-low" aria-hidden>
          A real canvas, not a picture — drag a shape
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
        // Out of the document's history: the diagram's undo is the scene
        // store's, and a whole-diagram prop write on the text stack would put
        // the same edit on two ledgers — ⌘Z in prose could pop a drawing.
        onChange={(data, mirror) =>
          editor.transact((tr) => {
            tr.setMeta("addToHistory", false);
            if (mirror) tr.setMeta(CANVAS_MIRROR_META, true);
            editor.updateBlock(block.id, { props: { data } });
          })
        }
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
