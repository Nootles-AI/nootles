"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as seed from "./data";
import type { Block, Edge, Msg, PageNode, Shape, ShapeKind } from "./data";

/**
 * Two stores, because they change at different speeds: the scene is rewritten
 * on every pointer move of a drag, and the document must not re-render for it.
 */

export type Tool = "move" | "scale" | "hand" | "zoom" | "rect" | "ellipse" | "polygon" | "diamond" | "text" | "connector" | "pen";
export type SheetName = "share" | "shortcuts" | "delete" | null;
export type Toast = { id: number; text: string; action?: string; leaving?: boolean };

type Ui = {
  pages: PageNode[];
  pageId: string;
  renaming: string | null;
  mode: "page" | "diagram";
  docMode: "create" | "complete";
  left: boolean;
  right: boolean;
  rightTab: "chat" | "design" | "layers";
  sheet: SheetName;
  /** The page a confirmation is about. */
  target: string | null;
  palette: boolean;
  toasts: Toast[];
  blocks: Block[];
  /** The block made last, which takes the caret as it mounts. */
  fresh: string | null;
  msgs: Msg[];
  streaming: string | null;
  thread: string;
  linkRole: "can view" | "can edit" | "off";
  /** The assistant's pending changes: a hunk in the page and a redrawn diagram. */
  review: "none" | "open" | "kept" | "discarded";
  expanded: boolean;
  /** A mockup whose diagram always opens into a stage. */
  autoStage: boolean;
};

type Scene = {
  shapes: Shape[];
  edges: Edge[];
  sel: string[];
  hover: string | null;
  tool: Tool;
  zoom: number;
  past: { shapes: Shape[]; edges: Edge[] }[];
  future: { shapes: Shape[]; edges: Edge[] }[];
};

function useUiStore(autoStage: boolean) {
  const [ui, setUi] = useState<Ui>({
    pages: seed.pages,
    pageId: "overview",
    renaming: null,
    mode: "page",
    docMode: "create",
    left: true,
    right: true,
    rightTab: "chat",
    sheet: null,
    target: null,
    palette: false,
    toasts: [],
    blocks: seed.blocks,
    fresh: null,
    msgs: seed.thread,
    streaming: null,
    thread: seed.threads[0].title,
    linkRole: "can view",
    review: "none",
    expanded: false,
    autoStage,
  });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nextId = useRef(1);
  /** Where the last press landed, so a sheet can grow out of what raised it. */
  const origin = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      origin.current = { x: e.clientX - innerWidth / 2, y: e.clientY - innerHeight / 2 };
    };
    document.addEventListener("pointerdown", onDown, true);
    const pending = timers.current;
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      pending.forEach(clearTimeout);
    };
  }, []);

  const act = useMemo(() => {
    const set = (patch: Partial<Ui> | ((u: Ui) => Partial<Ui>)) =>
      setUi((u) => ({ ...u, ...(typeof patch === "function" ? patch(u) : patch) }));
    const later = (ms: number, run: () => void) => timers.current.push(setTimeout(run, ms));

    const toast = (text: string, action?: string) => {
      const id = nextId.current++;
      set((u) => ({ toasts: [...u.toasts, { id, text, action }] }));
      later(3200, () => dismiss(id));
    };
    const dismiss = (id: number) => {
      set((u) => ({ toasts: u.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
      later(260, () => set((u) => ({ toasts: u.toasts.filter((t) => t.id !== id) })));
    };

    return {
      set,
      toast,
      dismiss,
      openPage: (pageId: string) => set({ pageId, mode: "page", palette: false }),
      addPage: () => {
        const id = `new-${nextId.current++}`;
        set((u) => ({ pages: [...u.pages, { id, title: "", blank: true }], pageId: id, renaming: id, mode: "page" }));
      },
      renamePage: (id: string, title: string) =>
        set((u) => ({ renaming: null, pages: u.pages.map((p) => (p.id === id ? { ...p, title } : p)) })),
      deletePage: (id: string) =>
        set((u) => {
          const rest = u.pages.filter((p) => p.id !== id);
          return { pages: rest, pageId: u.pageId === id ? rest[0]?.id ?? "" : u.pageId, sheet: null };
        }),
      toggleTodo: (id: string) =>
        set((u) => ({ blocks: u.blocks.map((b) => (b.id === id && b.type === "todo" ? { ...b, done: !b.done } : b)) })),
      insertBlock: (after: string, type: string) =>
        set((u) => {
          const id = `blk-${nextId.current++}`;
          const made: Block =
            type === "todo"
              ? { id, type: "todo", text: "", done: false }
              : type === "bullet"
                ? { id, type: "bullet", text: "" }
                : type === "h1" || type === "h2"
                  ? { id, type: "h2", text: "" }
                  : type === "quote"
                    ? { id, type: "quote", text: "" }
                    : type === "code"
                      ? { id, type: "code", lang: "TypeScript", text: "" }
                      : type === "table"
                        ? { id, type: "table", rows: [["", ""], ["", ""]] }
                        : { id, type: "p", text: "" };
          const at = u.blocks.findIndex((b) => b.id === after);
          return { fresh: id, blocks: [...u.blocks.slice(0, at + 1), made, ...u.blocks.slice(at + 1)] };
        }),
      removeBlock: (id: string) => set((u) => ({ blocks: u.blocks.filter((b) => b.id !== id) })),
      acceptGhost: (id: string) =>
        set((u) => ({
          blocks: u.blocks.map((b) => (b.id === id && "ghost" in b && b.ghost ? { ...b, ghost: undefined, arrived: true } : b)),
        })),
      /** The assistant's reply is a script typed out on a timer. No model is called. */
      send: (text: string) => {
        const mine: Msg = { id: `m-${nextId.current++}`, from: "you", text };
        set((u) => ({ msgs: [...u.msgs, mine], streaming: "" }));
        const words = seed.scripted.text.split(" ");
        words.forEach((_, i) =>
          later(420 + i * 55, () => set({ streaming: words.slice(0, i + 1).join(" ") })),
        );
        later(420 + words.length * 55 + 200, () =>
          set((u) => ({
            streaming: null,
            review: "open",
            msgs: [...u.msgs, { id: `m-${nextId.current++}`, from: "ai", text: seed.scripted.text, steps: seed.scripted.steps }],
          })),
        );
      },
      newThread: () => set({ msgs: [], thread: "New chat", streaming: null, review: "none" }),
    };
  }, []);

  return { ui, act, origin };
}

function useSceneStore() {
  const [scene, setScene] = useState<Scene>({
    shapes: seed.shapes,
    edges: seed.edges,
    sel: [],
    hover: null,
    tool: "move",
    zoom: 1,
    past: [],
    future: [],
  });
  const nextId = useRef(1);

  const act = useMemo(() => {
    const set = (patch: Partial<Scene> | ((s: Scene) => Partial<Scene>)) =>
      setScene((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
    /** Called once as a gesture starts, so a whole drag is one step back. */
    const record = () => set((s) => ({ past: [...s.past.slice(-40), { shapes: s.shapes, edges: s.edges }], future: [] }));
    const patch = (ids: string[], change: Partial<Shape> | ((sh: Shape) => Partial<Shape>)) =>
      set((s) => ({
        shapes: s.shapes.map((sh) => (ids.includes(sh.id) ? { ...sh, ...(typeof change === "function" ? change(sh) : change) } : sh)),
      }));
    return {
      set,
      record,
      patch,
      select: (ids: string[]) => set({ sel: ids }),
      hover: (id: string | null) => set((s) => (s.hover === id ? {} : { hover: id })),
      tool: (tool: Tool) => set({ tool }),
      zoomBy: (k: number) => set((s) => ({ zoom: Math.min(2, Math.max(0.5, Math.round(s.zoom * k * 100) / 100)) })),
      add: (kind: ShapeKind, x: number, y: number) => {
        const id = `s-${nextId.current++}`;
        const isText = kind === "text";
        record();
        set((s) => ({
          shapes: [
            ...s.shapes,
            {
              id,
              kind,
              name: isText ? "Text" : kind === "ellipse" ? "Ellipse" : kind === "diamond" ? "Diamond" : kind === "polygon" ? "Polygon" : "Rectangle",
              x: Math.round(x - (isText ? 0 : 74)),
              y: Math.round(y - (isText ? 0 : 26)),
              w: 148,
              h: isText ? 24 : 52,
              r: kind === "ellipse" ? 999 : kind === "rect" ? 10 : 0,
              fill: isText ? "transparent" : "#F2F2F0",
              stroke: isText ? "transparent" : "#D8D8D4",
              text: isText ? "Text" : "",
              size: 13,
              weight: 500,
              opacity: 100,
            },
          ],
          sel: [id],
          tool: "move",
        }));
      },
      connect: (from: string, to: string) => {
        if (from === to) return;
        record();
        set((s) => ({ edges: [...s.edges, { id: `e-${nextId.current++}`, from, to }], tool: "move" }));
      },
      remove: () => {
        record();
        set((s) => ({
          shapes: s.shapes.filter((sh) => !s.sel.includes(sh.id)),
          edges: s.edges.filter((e) => !s.sel.includes(e.id) && !s.sel.includes(e.from) && !s.sel.includes(e.to)),
          sel: [],
        }));
      },
      reorder: (id: string, to: number) => {
        record();
        set((s) => {
          const from = s.shapes.findIndex((sh) => sh.id === id);
          const next = [...s.shapes];
          const [moved] = next.splice(from, 1);
          next.splice(from < to ? to - 1 : to, 0, moved);
          return { shapes: next };
        });
      },
      undo: () =>
        set((s) => {
          const last = s.past[s.past.length - 1];
          if (!last) return {};
          return { ...last, past: s.past.slice(0, -1), future: [{ shapes: s.shapes, edges: s.edges }, ...s.future], sel: [] };
        }),
      redo: () =>
        set((s) => {
          const [next, ...rest] = s.future;
          if (!next) return {};
          return { ...next, future: rest, past: [...s.past, { shapes: s.shapes, edges: s.edges }], sel: [] };
        }),
      /** What "Keep" on the assistant's proposal does to the picture. */
      applyProposal: () => {
        record();
        set((s) => ({
          shapes: [
            ...s.shapes.filter((sh) => sh.kind !== "tag").map((sh) => (["a", "b", "c"].includes(sh.id) ? { ...sh, y: 150 } : sh.id === "redis" ? { ...sh, x: 224, y: 62, w: 124 } : sh)),
            { id: "edge", kind: "rect" as const, name: "Edge limiter", x: 28, y: 62, w: 148, h: 52, r: 10, fill: "#2B2B28", stroke: "#2B2B28", text: "Edge limiter", size: 13, weight: 500, opacity: 100 },
          ],
          edges: [
            { id: "p1", from: "edge", to: "a" },
            { id: "p2", from: "edge", to: "b" },
            { id: "p3", from: "edge", to: "c" },
            { id: "p4", from: "edge", to: "redis" },
          ],
          sel: ["edge"],
        }));
      },
    };
  }, []);

  return { scene, act };
}

type UiStore = ReturnType<typeof useUiStore>;
type SceneStore = ReturnType<typeof useSceneStore>;

const UiCtx = createContext<UiStore | null>(null);
const SceneCtx = createContext<SceneStore | null>(null);
const LayerCtx = createContext<HTMLDivElement | null>(null);

export function useUi() {
  const store = useContext(UiCtx);
  if (!store) throw new Error("useUi outside <Kit>");
  return store;
}
export function useScene() {
  const store = useContext(SceneCtx);
  if (!store) throw new Error("useScene outside <Kit>");
  return store;
}
/** Where overlays portal to: inside the mockup's root, so its tokens reach them. */
export function useLayer() {
  return useContext(LayerCtx);
}

export function Kit({ className, stage = false, children }: { className: string; stage?: boolean; children: ReactNode }) {
  const ui = useUiStore(stage);
  const scene = useSceneStore();
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  return (
    <UiCtx.Provider value={ui}>
      <SceneCtx.Provider value={scene}>
        <LayerCtx.Provider value={layer}>
          <div className={`ek ${className}`} data-mode={ui.ui.mode}>
            {children}
            <div ref={setLayer} className="ek-layer" />
          </div>
        </LayerCtx.Provider>
      </SceneCtx.Provider>
    </UiCtx.Provider>
  );
}
