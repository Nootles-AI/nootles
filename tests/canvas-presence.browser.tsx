// One person per browser, each with a REAL YConvexProvider over a stand-in
// Convex client whose backend lives in the Node runner — so awareness and doc
// updates cross between the two on the provider's own cadence (200ms awareness
// throttle, 500ms flush) plus the runner's network latency. See the runner,
// `canvas-presence.browser.mjs`, for what is checked and why.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { getFunctionName } from "convex/server";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import { findNode, type Scene, type SceneNode } from "../app/components/editor/canvas/scene/types";
import { CanvasShellContext, type ActiveCanvas } from "../app/components/editor/canvas/shell";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { undoScope, useWorkspaceHistory, WorkspaceHistoryProvider } from "../app/lib/history/useWorkspaceHistory";
import { createRemoteCarets } from "../app/lib/sync/remoteCarets";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import { YConvexProvider } from "../app/lib/sync/YConvexProvider";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";
// The workspace loads it with the canvas toolbar, which this page has no room for.
import "../app/components/editor/canvas/canvas.css";

// The production list, from `Editor.tsx`.
const EXTENSIONS = [completionExtension, reviewExtension, hintExtension, arrivalFlashExtension, blockSelectionExtension];
type Editor = typeof schema.BlockNoteEditor;
const PAGE = "page" as Id<"pages">;
const DOC_ID = "doc-canvas-presence";

const node = (
  kind: "rect" | "group",
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  background: string,
  extra: { rot?: number; children?: SceneNode[] } = {},
): SceneNode =>
  ({
    id, kind, x, y, w, h,
    rot: extra.rot ?? 0,
    style: { background },
    label: "", locked: false, hidden: false, attrs: {},
    ...(kind === "group" ? { children: extra.children ?? [] } : {}),
  }) as SceneNode;

/**
 * `a` and `b` joined by a connector, `r` turned 30°, and a group `g` whose
 * child `c1` can be someone's selection while the group moves.
 */
const SCENE: Scene = {
  w: 900,
  h: 520,
  style: { background: "#fff" },
  attrs: {},
  nodes: [
    node("rect", "a", 40, 40, 120, 70, "#f4c7c3"),
    node("rect", "r", 240, 50, 120, 70, "#d9c3f4", { rot: 30 }),
    node("rect", "b", 460, 40, 120, 70, "#c3d7f4"),
    node("group", "g", 600, 300, 240, 120, "#f5f5f4", {
      children: [
        node("rect", "c1", 20, 20, 90, 70, "#c3f4d2"),
        node("rect", "c2", 130, 30, 90, 70, "#f4ecc3"),
      ],
    }),
  ],
  edges: [{ id: "e1", from: "a", to: "b", label: "", style: {}, attrs: {} }],
};

const BLOCKS = [
  { type: "heading", props: { level: 1 }, content: "Launch plan" },
  { type: "canvas", props: { data: serializeScene(SCENE) } },
  { type: "paragraph", content: "" },
];

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => {
  const u = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
};

type Row = { sessionId: string; clientId: number; userId: string | null; user: { name: string; color: string }; state: ArrayBuffer; updatedAt: number };

/** This browser's replica of the Node backend: what its subscriptions last delivered. */
class Replica {
  seq = 0;
  log: { seq: number; update: ArrayBuffer }[] = [];
  rows: Row[] = [];
  metaW = new Set<() => void>();
  presW = new Set<() => void>();
  push(ev: { kind: string; seq?: number; update?: string; rows?: (Omit<Row, "state"> & { state: string })[] }) {
    if (ev.kind === "append") {
      this.log.push({ seq: ev.seq!, update: unb64(ev.update!) });
      this.seq = Math.max(this.seq, ev.seq!);
      for (const w of this.metaW) w();
    } else if (ev.kind === "rows") {
      this.rows = ev.rows!.map((r) => ({ ...r, state: unb64(r.state) }));
      for (const w of this.presW) w();
    }
  }
  read(name: string, args: Record<string, unknown>) {
    const meta = { seq: this.seq, snapshotSeq: 0, snapshotParts: 0 };
    if (name === "ydoc:meta") return meta;
    if (name === "ydoc:load") return { ...meta, updates: this.log.filter((r) => r.seq > (args.afterSeq as number)).map((r) => ({ ...r })) };
    if (name === "ydoc:updatesSince") return this.log.filter((r) => r.seq > (args.afterSeq as number)).map((r) => ({ ...r }));
    if (name === "ydoc:snapshot") return null;
    if (name === "presence:list") return this.rows.map((r) => ({ ...r }));
    throw new Error(`replica has no query ${name}`);
  }
  client(): ConvexReactClient {
    const call = (window as unknown as { backendCall: (n: string, a: unknown) => Promise<unknown> }).backendCall;
    return {
      watchQuery: (ref: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(ref as never);
        const set = name === "presence:list" ? this.presW : this.metaW;
        return {
          onUpdate: (cb: () => void) => {
            set.add(cb);
            return () => set.delete(cb);
          },
          localQueryResult: () => this.read(name, args),
        };
      },
      query: async (ref: unknown, args: Record<string, unknown>) => this.read(getFunctionName(ref as never), args),
      mutation: async (ref: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(ref as never);
        if (name === "ydoc:append") {
          const chunks = (args.chunks as ArrayBuffer[] | undefined) ?? [args.update as ArrayBuffer];
          return call(name, { chunks: chunks.map(b64) });
        }
        if (name === "presence:heartbeat") return call(name, { ...args, state: b64(args.state as ArrayBuffer) });
        if (name === "presence:leave") return call(name, args);
        return null; // previews and digests: derived data, not under test
      },
    } as unknown as ConvexReactClient;
  }
}

const replica = new Replica();
const convexReact = new ConvexReactClient("https://canvas-presence-test.invalid", { skipConvexDeploymentUrlCheck: true });
let editor: Editor;
let provider: YConvexProvider;
let active: ActiveCanvas | null = null;

function Page({ editor }: { editor: Editor }) {
  const spine = useWorkspaceHistory();
  useTextUndoDomain(spine, editor as unknown as UndoHostEditor, "doc", PAGE);
  const [canvas, setCanvas] = useState<ActiveCanvas | null>(null);
  const shell = useMemo(() => ({ active: canvas, set: setCanvas }), [canvas]);
  useEffect(() => {
    active = canvas;
  }, [canvas]);
  const editing = canvas !== null;
  useEffect(() => {
    if (!editing) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".nt-canvas-viewport")) setCanvas(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [editing]);
  return (
    <CanvasShellContext value={shell}>
      <main style={{ height: "100vh", overflow: "auto" }}>
        <div {...undoScope} style={{ maxWidth: 1100, padding: "32px 40px", boxSizing: "border-box" }}>
          <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
        </div>
      </main>
    </CanvasShellContext>
  );
}

const until = async (ok: () => boolean, what: string, ms = 10_000) => {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function start(user: { name: string; color: string }, seed: boolean) {
  const doc = new Y.Doc();
  provider = new YConvexProvider(replica.client(), DOC_ID, doc);
  provider.connect();
  await provider.whenSynced;
  const carets = createRemoteCarets(provider.awareness);
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [...EXTENSIONS, remoteScrollExtension],
      collaboration: {
        fragment: doc.getXmlFragment("prosemirror"),
        user,
        provider: { awareness: provider.awareness },
        showCursorLabels: "always",
        renderCursor: carets.render,
      },
    } as never),
  ) as unknown as Editor;
  provider.awareness.setLocalStateField("user", user);
  createRoot(document.getElementById("app")!).render(
    <ConvexProvider client={convexReact}>
      <WorkspaceHistoryProvider projectId="project">
        <CurrentPageProvider pageId={PAGE}>
          <Page editor={editor} />
        </CurrentPageProvider>
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
  carets.attach();
  await until(() => document.querySelector(".bn-editor") !== null, "editor");
  if (seed) {
    editor.transact((tr) => {
      tr.setMeta("addToHistory", false);
      editor.replaceBlocks(editor.document, BLOCKS as never);
    });
  }
  await until(() => shapeEl("c1") !== null, "diagram");
}

const layer = () => document.querySelector<HTMLElement>(".nt-editor .nt-canvas-scene");

function shapeEl(id: string) {
  return layer()?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? null;
}

/** A client point for a scene point — each window pans and centres its own way. */
function clientOf(x: number, y: number) {
  const l = layer()!;
  const f = l.getBoundingClientRect();
  const zoom = new DOMMatrix(getComputedStyle(l).transform).a || 1;
  return { x: f.left + x * zoom, y: f.top + y * zoom };
}

function centreOf(el: Element | null) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** An element's drawn bound in scene px, relative to the scene layer. */
function sceneRect(el: Element | null) {
  const l = layer();
  if (!el || !l) return null;
  const f = l.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const zoom = new DOMMatrix(getComputedStyle(l).transform).a || 1;
  const k = (v: number) => Math.round((v / zoom) * 10) / 10;
  return { x: k(r.left - f.left), y: k(r.top - f.top), w: k(r.width), h: k(r.height) };
}

const ghosts = () => [...document.querySelectorAll(".nt-editor .nt-copresence-ghost")];

type Sample = {
  t: number;
  down: boolean;
  shape: ReturnType<typeof sceneRect>;
  outline: ReturnType<typeof sceneRect>;
  ghosts: ReturnType<typeof sceneRect>[];
  ghostTransform: string | null;
  edge: string | null;
  halo: string | null;
};
let samples: Sample[] = [];
let recording = false;
let pointerDown = false;
window.addEventListener("pointerdown", () => (pointerDown = true), true);
window.addEventListener("pointerup", () => (pointerDown = false), true);

/**
 * One sample per rendered frame, in a task posted from rAF — after that frame's
 * rAF callbacks (the gesture's writes, the painter's) and its rendering, so it
 * reads what that frame showed.
 */
function record(id: string) {
  samples = [];
  recording = true;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const outline = document.querySelector(".nt-editor .nt-ov-outline");
    const shown = !!outline && outline.getBoundingClientRect().width > 0 && (outline.closest("g") as SVGGElement | null)?.style.display !== "none";
    const ghost = ghosts()[0] as HTMLElement | undefined;
    samples.push({
      t: Math.round(performance.now()),
      down: pointerDown,
      shape: sceneRect(shapeEl(id)),
      outline: shown ? sceneRect(outline) : null,
      ghosts: ghosts().map((g) => sceneRect(g)),
      ghostTransform: ghost?.style.transform ?? null,
      edge: document.querySelector(`.nt-editor .nt-edge-line[data-edge="e1"]`)?.getAttribute("d") ?? null,
      halo: document.querySelector(".nt-editor .nt-copresence-edges path")?.getAttribute("d") ?? null,
    });
  };
  const loop = () => {
    if (!recording) return;
    channel.port2.postMessage(0);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function stop() {
  recording = false;
  return samples;
}

const scene = () => active?.api.store.getScene() ?? null;

const probe = {
  start,
  clientOf,
  receive: (ev: never) => replica.push(ev),
  point: (id: string) => centreOf(shapeEl(id)),
  /** The centre of an overlay handle: `edges`/`zones` group, nth rect (1-based). */
  handle: (group: string, nth: number) =>
    centreOf(document.querySelector(`.nt-editor .nt-ov-${group} rect:nth-child(${nth})`)),
  claimed: () => active !== null,
  select: (ids: string[], edgeIds: string[] = []) => {
    const selection = active!.api.selection;
    selection.select(ids);
    if (edgeIds.length) selection.selectEdges(edgeIds);
  },
  ghosts: () => ghosts().map((g) => sceneRect(g)),
  halos: () => document.querySelectorAll(".nt-editor .nt-copresence-edges path").length,
  shape: (id: string) => sceneRect(shapeEl(id)),
  model: (id: string) => {
    const s = scene();
    const n = s && findNode(s, id);
    return n ? { x: n.x, y: n.y, w: n.w, h: n.h, rot: n.rot } : null;
  },
  count: () => {
    let n = 0;
    const walk = (nodes: SceneNode[]) => {
      for (const x of nodes) {
        n += 1;
        if (x.kind === "group") walk(x.children);
      }
    };
    walk(scene()?.nodes ?? []);
    return n;
  },
  record,
  stop,
};
(window as unknown as { probe: typeof probe }).probe = probe;
