"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSceneSnapshot, type SceneStore } from "../engine/useScene";
import {
  hasText,
  isGroup,
  type NodeFrame,
  type NodeId,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type SceneOp,
  type ShapeParams,
  type StyleMap,
  type StylePatch,
} from "../scene/types";
import {
  ColorVariablesContext,
  readColorVariables,
  type ColorVariablesApi,
} from "./colorVariables";
import { ColorField } from "./controls/ColorField";
import { LiveEditContext, type LiveEdit } from "./controls/live";
import { NumberField } from "./controls/NumberField";
import { PanelSection } from "./controls/PanelSection";
import { rememberStyle } from "../render/newShape";
import { AlignRow } from "./sections/AlignRow";
import { EdgeSection } from "./sections/EdgeSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { EffectsSection } from "./sections/EffectsSection";
import { FillSection } from "./sections/FillSection";
import { LayoutSection } from "./sections/LayoutSection";
import { PositionSection } from "./sections/PositionSection";
import { hasShapeParams, ShapeSection } from "./sections/ShapeSection";
import { StrokeSection } from "./sections/StrokeSection";
import { TypographySection } from "./sections/TypographySection";
import "./panel.css";

/**
 * The right sidebar: Figma's order, top to bottom, over the current selection.
 *
 * Sections are dumb — they read the selected nodes and call `patch` or
 * `setStyle`. Both are built here, once, so that a section cannot invent a
 * second way to reach the store and cannot get history wrong.
 *
 * Both apply immediately, which is what makes a slider preview: a control that
 * emits on every move moves the canvas with it. History is what turns that back
 * into one edit — every pointer that goes down in the panel holds the store's
 * gesture bracket open until it comes up, so a drag across a range is one undo
 * entry however many changes it made.
 */

/** The fixed section contract, imported by every section. */
export type SectionProps = {
  selection: SceneNode[];
  patch: (fn: (node: SceneNode) => Partial<SceneNode>) => void;
  setStyle: (decls: StylePatch) => void;
  /**
   * Parametric geometry — a polygon's sides, an ellipse's arc. `setShape`
   * replaces, so the function returns everything the node should end up with;
   * `null` leaves it alone, which is how an edit aimed at one kind passes over
   * the rest of a mixed selection.
   */
  setShape: (fn: (node: SceneNode) => ShapeParams | null) => void;
  /** For a continuous edit the panel's own pointer bracket cannot see — a
   *  gesture on `window`, or one driven by something other than a pointer. */
  live: LiveEdit;
};

/**
 * The diagram's own properties. `SceneOp` addresses nodes and has no root op,
 * so these go back to the canvas surface, which owns the block's source.
 */
export type DiagramPatch = { w?: number; h?: number; style?: StylePatch };

export type StylePanelProps = {
  store: SceneStore;
  /** Resolved selection in document order — `ResolvedSelection.nodes`. */
  selection: readonly SceneNode[];
  /** Resolved connectors — `ResolvedSelection.edges`. Never both at once. */
  edges: readonly SceneEdge[];
  onDiagramChange: (patch: DiagramPatch) => void;
  /** `CanvasApi.previewSize` — a size shown without being committed. */
  onPreviewSize?: (size: { w?: number; h?: number }) => void;
  /** `CanvasApi.previewStyle` — declarations shown without being committed. */
  onPreviewStyle?: (decls: StylePatch) => void;
};

export function StylePanel({
  store,
  selection,
  edges,
  onDiagramChange,
  onPreviewSize,
  onPreviewStyle,
}: StylePanelProps) {
  const scene = useSceneSnapshot(store);
  const { run, live, flush } = useHistoryBracket(store);

  const nodes = selection.slice();
  const props: SectionProps = {
    selection: nodes,
    patch: (fn) => run(compile(nodes, fn)),
    setStyle: (decls) =>
      run(nodes.length ? [{ type: "setStyle", ids: idsOf(nodes), decls }] : []),
    setShape: (fn) => run(compileShape(nodes, fn)),
    live,
  };

  /** One bracket per pointer, so any drag on any control is one entry. */
  const hold = useCallback(() => {
    live.begin();
    // `blur` is the backstop: a pointer released outside the window may never
    // report it, and a bracket left open would block undo for the session.
    const done = () => {
      for (const type of ["pointerup", "pointercancel", "blur"]) {
        window.removeEventListener(type, done);
      }
      live.end();
    };
    for (const type of ["pointerup", "pointercancel", "blur"]) {
      window.addEventListener(type, done);
    }
  }, [live]);

  /**
   * The diagram's own fields are not ops: they re-serialize the block and come
   * back through it, and the store defers an incoming source while a bracket is
   * open. Closing first is what makes the canvas repaint at once.
   */
  const changeDiagram = useCallback(
    (patch: DiagramPatch) => {
      flush();
      onDiagramChange(patch);
    },
    [flush, onDiagramChange],
  );

  // Colour variables are the diagram's own custom properties, so the surface is
  // both where they are declared and what resolves them for every shape.
  const colorVars = useMemo<ColorVariablesApi>(
    () => ({
      variables: readColorVariables(scene.style),
      setStyle: (decls) => changeDiagram({ style: decls }),
    }),
    [scene.style, changeDiagram],
  );

  return (
    <ColorVariablesContext value={colorVars}>
      <aside className="ab-style-panel" aria-label="Design">
        {/* The layers rail says what it is; this one used to say nothing, which
          left the two halves of the same shell looking unrelated. */}
        <div className="ab-section-label ab-style-panel-head">
          <span>{nodes.length === 0 ? "Canvas" : "Design"}</span>
          {nodes.length > 1 && (
            <span className="ab-meta">{nodes.length} selected</span>
          )}
        </div>
        <div
          className="ab-style-panel-body"
          // Sections must stay the body's direct children — the rule that draws
          // the dividers says so — hence the handler here rather than a wrapper.
          onPointerDown={nodes.length ? hold : undefined}
        >
          {edges.length > 0 ? (
          // A connector has no box, so none of the shape sections apply to it.
          // The panel shows the edge inspector instead of them, not with them.
          <LiveEditContext value={live}>
            <EdgeSection
              scene={scene}
              edges={edges}
              setLabel={(id, label) => run([{ type: "setEdgeLabel", id, label }])}
              setStyle={(ids, decls) =>
                run([{ type: "setEdgeStyle", ids: [...ids], decls }])
              }
              reconnect={(id, from, to) =>
                run([{ type: "reconnect", id, from, to }])
              }
              remove={(ids) => run([{ type: "removeEdge", ids: [...ids] }])}
            />
          </LiveEditContext>
        ) : nodes.length === 0 ? (
            // Deliberately outside the live context: one of these costs a
            // re-parse of the whole canvas, so it is committed on release — and
            // previewed in the meantime by the surface, which needs neither.
            <DiagramFields
              scene={scene}
              onChange={changeDiagram}
              onPreviewSize={onPreviewSize}
              onPreviewStyle={onPreviewStyle}
            />
          ) : (
            <LiveEditContext value={live}>
              <AlignRow {...props} />
              <PositionSection {...props} />
              {nodes.some(hasShapeParams) && <ShapeSection {...props} />}
              {nodes.some(isGroup) && <LayoutSection {...props} />}
              {nodes.some(hasText) && <TypographySection {...props} />}
              <AppearanceSection {...props} />
              <FillSection {...props} />
              <StrokeSection {...props} />
              <EffectsSection {...props} />
            </LiveEditContext>
          )}
        </div>
      </aside>
    </ColorVariablesContext>
  );
}

/** Nothing selected: Figma shows the page, and the surface is the page here. */
function DiagramFields({
  scene,
  onChange,
  onPreviewSize,
  onPreviewStyle,
}: {
  scene: Scene;
  onChange: (patch: DiagramPatch) => void;
  onPreviewSize?: (size: { w?: number; h?: number }) => void;
  onPreviewStyle?: (decls: StylePatch) => void;
}) {
  return (
    <PanelSection title="Canvas">
      <div className="ab-ctl-grid">
        <NumberField
          label="W"
          name="Canvas width"
          value={scene.w}
          min={1}
          onChange={(w) => onChange({ w })}
          onPreview={onPreviewSize && ((w) => onPreviewSize({ w }))}
        />
        <NumberField
          label="H"
          name="Canvas height"
          value={scene.h}
          min={1}
          onChange={(h) => onChange({ h })}
          onPreview={onPreviewSize && ((h) => onPreviewSize({ h }))}
        />
      </div>
      <div className="ab-ctl-row">
        <ColorField
          label="Background"
          value={scene.style.background ?? ""}
          onChange={(background) =>
            onChange({ style: { background: background || undefined } })
          }
          onPreview={
            onPreviewStyle && ((background) => onPreviewStyle({ background }))
          }
        />
      </div>
    </PanelSection>
  );
}

/**
 * How long a run of typed panel edits stays one undo entry. A gesture says when
 * it ended and is bracketed by that; a keystroke does not, so it is closed by
 * quiet instead — 350ms is far longer than a repeat and shorter than the pause
 * between two edits you meant to make separately.
 */
const IDLE_MS = 350;

function useHistoryBracket(store: SceneStore): {
  run: (ops: readonly SceneOp[]) => void;
  live: LiveEdit;
  flush: () => void;
} {
  const open = useRef(false);
  /** Gestures currently holding the bracket open. */
  const held = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!open.current) return;
    open.current = false;
    store.commit();
  }, [store]);

  const live = useMemo<LiveEdit>(
    () => ({
      begin: () => {
        // Whatever the keyboard was writing ends here; this is its own entry.
        if (held.current === 0) close();
        held.current += 1;
        if (open.current) return;
        open.current = true;
        store.begin();
      },
      end: () => {
        if (held.current === 0) return;
        held.current -= 1;
        if (held.current === 0) close();
      },
    }),
    [store, close],
  );

  const run = useCallback(
    (ops: readonly SceneOp[]) => {
      if (ops.length === 0) return;
      // The last styling a shape was given is what the next one is drawn with.
      for (const op of ops) if (op.type === "setStyle") rememberStyle(op.decls);
      if (!open.current) {
        open.current = true;
        store.begin();
      }
      store.dispatch(ops);
      // Held: the gesture closes it. Otherwise only quiet can.
      if (held.current > 0) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(close, IDLE_MS);
    },
    [store, close],
  );

  // An unmount mid-bracket would leave the store's depth above zero, which
  // blocks undo for the rest of the session.
  useEffect(
    () => () => {
      held.current = 0;
      close();
    },
    [close],
  );

  const flush = useCallback(() => {
    if (held.current === 0) close();
  }, [close]);

  return { run, live, flush };
}

/**
 * A per-node change, expressed as the ops that make it.
 *
 * Box changes batch into one `resize` and equal rotations into one `rotate`,
 * because a multi-selection usually agrees; everything else is per node. Path
 * `d` is deliberately not here — editing it also changes the node's bounds, so
 * it belongs to the pen tool, which knows the new frame.
 */
function compile(
  nodes: readonly SceneNode[],
  fn: (node: SceneNode) => Partial<SceneNode>,
): SceneOp[] {
  const frames: NodeFrame[] = [];
  const spins = new Map<number, NodeId[]>();
  const ops: SceneOp[] = [];

  for (const node of nodes) {
    const next = fn(node);

    if (
      next.x !== undefined ||
      next.y !== undefined ||
      next.w !== undefined ||
      next.h !== undefined
    ) {
      frames.push({
        id: node.id,
        x: next.x ?? node.x,
        y: next.y ?? node.y,
        w: next.w ?? node.w,
        h: next.h ?? node.h,
      });
    }

    if (next.rot !== undefined) {
      const ids = spins.get(next.rot);
      if (ids) ids.push(node.id);
      else spins.set(next.rot, [node.id]);
    }

    if (next.style) {
      const decls = styleDiff(node.style, next.style);
      if (Object.keys(decls).length > 0) {
        ops.push({ type: "setStyle", ids: [node.id], decls });
      }
    }
    if (next.label !== undefined) {
      ops.push({ type: "setLabel", id: node.id, label: next.label });
    }
    // Present-but-undefined clears an explicit name; absent means "leave it".
    if ("name" in next) {
      ops.push({ type: "setName", id: node.id, name: next.name });
    }
    if (next.locked !== undefined) {
      ops.push({ type: "setLocked", ids: [node.id], locked: next.locked });
    }
    if (next.hidden !== undefined) {
      ops.push({ type: "setHidden", ids: [node.id], hidden: next.hidden });
    }
  }

  const head: SceneOp[] = [];
  if (frames.length > 0) head.push({ type: "resize", frames });
  for (const [rot, ids] of spins) head.push({ type: "rotate", ids, rot });
  return [...head, ...ops];
}

/**
 * One `setShape` per node the function speaks for. Not batched by value: two
 * ellipses in a selection usually differ in the fields the edit did not touch,
 * and a shared op would flatten them onto the one being edited.
 */
function compileShape(
  nodes: readonly SceneNode[],
  fn: (node: SceneNode) => ShapeParams | null,
): SceneOp[] {
  const ops: SceneOp[] = [];
  for (const node of nodes) {
    const params = fn(node);
    if (params) ops.push({ type: "setShape", ids: [node.id], params });
  }
  return ops;
}

/** A whole replacement style as a patch: dropped properties become removals. */
function styleDiff(from: StyleMap, to: StyleMap): StylePatch {
  const decls: StylePatch = {};
  for (const prop of Object.keys(to)) {
    if (from[prop] !== to[prop]) decls[prop] = to[prop];
  }
  for (const prop of Object.keys(from)) {
    if (!(prop in to)) decls[prop] = undefined;
  }
  return decls;
}

function idsOf(nodes: readonly SceneNode[]): NodeId[] {
  return nodes.map((node) => node.id);
}
