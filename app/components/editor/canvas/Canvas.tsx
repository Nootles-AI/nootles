"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  ConnectionMode,
  ConnectionLineType,
  MarkerType,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { ShapeNode } from "./ShapeNode";
import { CanvasAiContext } from "./canvasAi";
import { CanvasToolbar } from "./CanvasToolbar";
import { layoutCanvas } from "./autoLayout";
import {
  canvasHeightFor,
  parseCanvas,
  serializeCanvas,
  type ShapeNode as ShapeNodeT,
  type CanvasEdge,
  type ShapeKind,
} from "./types";

const nodeTypes = { shape: ShapeNode };

const EDGE_COLOR = "#9a95a6";
const defaultEdgeOptions = {
  type: "smoothstep",
  pathOptions: { borderRadius: 14 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 15,
    height: 15,
    color: EDGE_COLOR,
  },
  style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
};

const DEFAULT_SIZE: Record<ShapeKind, { width: number; height: number }> = {
  rectangle: { width: 148, height: 64 },
  ellipse: { width: 140, height: 96 },
  diamond: { width: 128, height: 96 },
  text: { width: 120, height: 40 },
};

let counter = 0;
const genId = () => `s${counter++}_${Math.round(performance.now())}`;

function CanvasInner({
  source,
  onChange,
}: {
  source: string;
  onChange: (source: string) => void;
}) {
  const initial = useMemo(() => parseCanvas(source), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Fit the canvas to its content so a small diagram doesn't sit in a mostly
  // empty box — and so the faded preview (same formula) is the same height as
  // the result. Derived from the PERSISTED source, not live node state, so it
  // can't resize while a shape is being dragged.
  const height = useMemo(() => canvasHeightFor(parseCanvas(source).nodes), [source]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ShapeNodeT>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>(initial.edges);
  const rf = useReactFlow<ShapeNodeT, CanvasEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last value we persisted; distinguishes our own round-tripped writes from
  // genuinely external `source` changes (AI ops, another synced tab).
  const lastSource = useRef(source);

  const persist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const s = serializeCanvas(rf.getNodes(), rf.getEdges());
      lastSource.current = s;
      onChange(s);
    }, 500);
  }, [rf, onChange]);

  // Reconcile external `source` changes (an AI op, or the same doc edited in
  // another tab). Our own debounced writes set `lastSource` first, so they
  // no-op here and never fight the user's in-progress drag/edit.
  useEffect(() => {
    if (source === lastSource.current) return;
    lastSource.current = source;
    const parsed = parseCanvas(source);
    setNodes(parsed.nodes);
    setEdges(parsed.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const onConnect: OnConnect = useCallback(
    (connection) => {
      setEdges((eds) => addEdge({ ...connection, ...defaultEdgeOptions }, eds));
      persist();
    },
    [setEdges, persist],
  );

  const addShapeAt = useCallback(
    (kind: ShapeKind, position: { x: number; y: number }) => {
      const node: ShapeNodeT = {
        id: genId(),
        type: "shape",
        position,
        selected: true,
        ...DEFAULT_SIZE[kind],
        // autoEdit drops the caret straight into the new shape.
        data: { label: "", shape: kind, autoEdit: true },
      };
      // Select only the new node so it's ready to style / connect.
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
      persist();
    },
    [setNodes, persist],
  );

  const addShapeAtCenter = useCallback(
    (kind: ShapeKind) => {
      const rect = wrapper.current?.getBoundingClientRect();
      // Cascade successive additions so they never stack on top of each other.
      const step = (rf.getNodes().length % 6) * 26;
      const pos = rect
        ? rf.screenToFlowPosition({
            x: rect.left + rect.width / 2 + step,
            y: rect.top + rect.height / 2 + step,
          })
        : { x: step, y: step };
      addShapeAt(kind, pos);
    },
    [rf, addShapeAt],
  );

  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // Only add a shape when double-clicking empty canvas, not a node/label.
      if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) {
        return;
      }
      const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addShapeAt("rectangle", pos);
    },
    [rf, addShapeAt],
  );

  const doLayout = useCallback(async () => {
    const laidOut = await layoutCanvas(rf.getNodes(), rf.getEdges());
    setNodes(laidOut);
    persist();
    window.setTimeout(() => rf.fitView({ padding: 0.25, duration: 320 }), 30);
  }, [rf, setNodes, persist]);

  const fit = useCallback(
    () => rf.fitView({ padding: 0.25, duration: 320 }),
    [rf],
  );

  const deleteSelected = useCallback((): boolean => {
    const nodes = rf.getNodes().filter((n) => n.selected);
    const edges = rf.getEdges().filter((e) => e.selected);
    if (nodes.length === 0 && edges.length === 0) return false;
    rf.deleteElements({ nodes, edges });
    persist();
    return true;
  }, [rf, persist]);

  const onNodeDragStop = useCallback(() => persist(), [persist]);

  // ---- Clipboard (internal to the canvas) --------------------------------
  const clipboard = useRef<{ nodes: ShapeNodeT[]; edges: CanvasEdge[] } | null>(
    null,
  );

  const copySelection = useCallback((): boolean => {
    const selected = rf.getNodes().filter((n) => n.selected);
    if (selected.length === 0) return false;
    const ids = new Set(selected.map((n) => n.id));
    const selectedEdges = rf
      .getEdges()
      .filter((e) => e.selected || (ids.has(e.source) && ids.has(e.target)));
    clipboard.current = { nodes: selected, edges: selectedEdges };
    return true;
  }, [rf]);

  const pasteClipboard = useCallback(() => {
    const clip = clipboard.current;
    if (!clip || clip.nodes.length === 0) return;
    const idMap = new Map<string, string>();
    const newNodes = clip.nodes.map((n) => {
      const id = genId();
      idMap.set(n.id, id);
      return {
        ...n,
        id,
        selected: true,
        position: { x: n.position.x + 28, y: n.position.y + 28 },
        data: { ...n.data, autoEdit: false },
      };
    });
    const newEdges = clip.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        ...e,
        id: genId(),
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        selected: false,
      }));
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...newNodes]);
    setEdges((es) => [...es, ...newEdges]);
    persist();
  }, [setNodes, setEdges, persist]);

  // Wire ⌘/Ctrl+C / X / V on the canvas, stopping propagation so the
  // surrounding ProseMirror editor doesn't also handle them.
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.isContentEditable) return; // editing a shape label
      const key = e.key.toLowerCase();
      // Delete/Backspace: remove selection here so ProseMirror doesn't eat it.
      if ((key === "backspace" || key === "delete") && !e.metaKey && !e.ctrlKey) {
        if (deleteSelected()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (key === "c" && copySelection()) {
        e.preventDefault();
        e.stopPropagation();
      } else if (key === "x" && copySelection()) {
        deleteSelected();
        e.preventDefault();
        e.stopPropagation();
      } else if (key === "v") {
        pasteClipboard();
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [copySelection, pasteClipboard, deleteSelected]);

  const hasSelection =
    nodes.some((n) => n.selected) || edges.some((e) => e.selected);

  return (
    <div
      ref={wrapper}
      className="ab-canvas"
      contentEditable={false}
      style={{ height }}
    >
      {nodes.length === 0 && (
        <div className="ab-canvas-hint">
          Add a shape from the toolbar, or double-click anywhere
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionMode={ConnectionMode.Loose}
        connectionLineType={ConnectionLineType.SmoothStep}
        connectionRadius={38}
        nodeOrigin={[0.5, 0.5]}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2.5}
        zoomOnScroll={false}
        panOnScroll={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        onDoubleClick={onPaneDoubleClick}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="#dcdae2" />
        <Panel position="top-center">
          <CanvasToolbar
            onAddShape={addShapeAtCenter}
            onLayout={doLayout}
            onFit={fit}
            onDelete={deleteSelected}
            hasSelection={hasSelection}
          />
        </Panel>
      </ReactFlow>
    </div>
  );
}

export function Canvas({
  getDocContext,
  ...props
}: {
  source: string;
  onChange: (source: string) => void;
  /** Surrounding page text, used to inform shape-label completion. */
  getDocContext?: () => string;
}) {
  // Keep the context value referentially stable. CanvasBlock passes a fresh
  // closure on every render, and a changing context value would re-render every
  // shape on each editor update.
  const ctxRef = useRef(getDocContext);
  useEffect(() => {
    ctxRef.current = getDocContext;
  });
  const ai = useMemo(() => ({ getDocContext: () => ctxRef.current?.() ?? "" }), []);
  return (
    <ReactFlowProvider>
      <CanvasAiContext.Provider value={ai}>
        <CanvasInner {...props} />
      </CanvasAiContext.Provider>
    </ReactFlowProvider>
  );
}
