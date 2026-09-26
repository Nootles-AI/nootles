"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Segmented } from "@/app/components/Segmented";
import { undoScope } from "@/app/lib/history/useWorkspaceHistory";
import type { BandRange } from "../engine/gestures";
import type { SceneStore } from "../engine/useScene";
import {
  findParent,
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
  isBoolean,
} from "../scene/types";
import { bandFloor, bandHeight } from "../scene/band";
import { canBoolean } from "../scene/boolean";
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
import { BooleanRow } from "./sections/BooleanRow";
import { EdgeSection } from "./sections/EdgeSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { EffectsSection } from "./sections/EffectsSection";
import { FillSection } from "./sections/FillSection";
import { LayoutSection } from "./sections/LayoutSection";
import { PositionSection } from "./sections/PositionSection";
import { SelectionColorsSection } from "./sections/SelectionColorsSection";
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
 * The diagram's own properties. Handed back to the canvas surface, which owns
 * turning them into a `setDiagram` op — the panel never sees the scene root.
 */
export type DiagramPatch = { w?: number; h?: number; wide?: boolean; style?: StylePatch };

/**
 * One diagram whose shapes the panel is editing. Ids repeat from one diagram
 * to the next, so every edit is compiled per target and lands in that
 * target's own store.
 */
export type PanelTarget = {
  blockId: string;
  store: SceneStore;
  scene: Scene;
  /** Resolved selection in document order — `ResolvedSelection.nodes`. */
  nodes: readonly SceneNode[];
  /** Resolved connectors. Never both at once, and never in more than one diagram. */
  edges: readonly SceneEdge[];
  /** Where a top-level shape may go, or `null` in a frame. */
  band: BandRange | null;
  setDiagram(patch: DiagramPatch): void;
};

/** The diagram the panel speaks for: its own fields, its connectors, its booleans. */
export type FocusedTarget = PanelTarget & {
  /** The boolean row makes a group and then wants it selected. */
  select(ids: readonly NodeId[]): void;
  /** `CanvasApi.previewSize` — a height shown without being committed. */
  previewSize?(h: number): void;
  /** `CanvasApi.previewStyle` — declarations shown without being committed. */
  previewStyle?(decls: StylePatch): void;
};

export type StylePanelProps = {
  /** Every diagram holding part of the selection, in document order; `focused` among them. */
  targets: readonly PanelTarget[];
  focused: FocusedTarget;
  /** One undo step for an edit that lands in several diagrams. */
  batch?: <T>(fn: () => T) => T;
};

const identity = <T,>(fn: () => T): T => fn();

export function StylePanel({ targets, focused, batch = identity }: StylePanelProps) {
  const scene = focused.scene;
  const stores = targets.map((t) => t.store);
  const { run, runEach, live } = useHistoryBracket(stores, focused.store, batch);

  const nodes = targets.flatMap((t) => t.nodes);
  const edges = focused.edges;
  const across = targets.filter((t) => t.nodes.length > 0).length > 1;

  // The panel's contents come in afresh when what they describe changes, and
  // only then. A CSS animation replays when its name does, so the two sides of
  // `turn` are the same fade under two names — nothing is remounted, which a
  // control in the middle of a gesture could not survive.
  const subject = `${targets
    .map((t) => `${t.blockId}:${t.nodes.map((n) => n.id).join()}`)
    .join("|")}|${edges.map((e) => e.id).join()}`;
  const [shown, setShown] = useState({ subject, turn: false });
  if (shown.subject !== subject) setShown({ subject, turn: !shown.turn });
  const props: SectionProps = {
    selection: nodes,
    patch: (fn) => runEach(targets.map((t) => [t.store, compile(t, fn)])),
    setStyle: (decls) =>
      runEach(
        targets.map((t) => [
          t.store,
          t.nodes.length ? [{ type: "setStyle", ids: idsOf(t.nodes), decls }] : [],
        ]),
      ),
    setShape: (fn) => runEach(targets.map((t) => [t.store, compileShape(t.nodes, fn)])),
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
   * The diagram's own fields land as a `setDiagram` op through the surface —
   * inside a live bracket when one is open (a variable recoloured mid-drag
   * belongs to the drag), its own history entry otherwise.
   */
  const changeDiagram = focused.setDiagram;

  // Colour variables are each diagram's own custom properties, so the surface
  // is both where they are declared and what resolves them for every shape.
  // Across diagrams, the ones every diagram declares — and a change to one is
  // a change to each.
  const colorVars: ColorVariablesApi = {
    variables: sharedVariables(targets, scene.style),
    setStyle: (decls) =>
      targets.length > 1
        ? batch(() => targets.forEach((t) => t.setDiagram({ style: decls })))
        : changeDiagram({ style: decls }),
  };

  return (
    <ColorVariablesContext value={colorVars}>
      <aside className="nt-style-panel" aria-label="Design" {...undoScope}>
        {/* The layers rail says what it is; this one used to say nothing, which
          left the two halves of the same shell looking unrelated. */}
        <div className="nt-section-label nt-style-panel-head">
          <span>{nodes.length === 0 ? "Canvas" : "Design"}</span>
          {nodes.length > 1 && (
            <span className="nt-meta">{nodes.length} selected</span>
          )}
        </div>
        <div
          className="nt-style-panel-body"
          data-turn={shown.turn ? "b" : "a"}
          // Sections must stay the body's direct children — the rule that draws
          // the dividers says so — hence the handler here rather than a wrapper.
          // Connectors too: an edge-colour drag is as much one gesture as a
          // shape's, and without the hold it split on the idle timer.
          onPointerDown={nodes.length || edges.length ? hold : undefined}
        >
          {edges.length > 0 ? (
          // A connector has no box, so none of the shape sections apply to it.
          // The panel shows the edge inspector instead of them, not with them.
          // Connectors are one diagram's, so this is the focused one's.
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
            // Deliberately outside the live context: a scrub previews through
            // the surface's own DOM writes and commits once on release, so the
            // whole drag is one entry without holding a bracket open.
            <DiagramFields
              scene={scene}
              onChange={changeDiagram}
              onPreviewSize={focused.previewSize}
              onPreviewStyle={focused.previewStyle}
            />
          ) : (
            <LiveEditContext value={live}>
              <AlignRow {...props} across={across} />
              {!across && canBoolean(nodes) && (
                <BooleanRow selection={nodes} scene={scene} run={run} select={focused.select} />
              )}
              <SelectionColorsSection
                selection={nodes}
                parts={targets}
                run={runEach}
              />
              <PositionSection {...props} />
              {nodes.some(hasShapeParams) && <ShapeSection {...props} />}
              {nodes.some((node) => isGroup(node) && !isBoolean(node)) && <LayoutSection {...props} />}
              {nodes.some(hasText) && <TypographySection {...props} />}
              <AppearanceSection {...props} />
              <FillSection {...props} />
              <StrokeSection {...props} />
              <EffectsSection {...props} />
            </LiveEditContext>
          )}
          {/* The diagram's own fields come after its shapes', for the one the
              panel speaks for; scrubbing them previews through the surface and
              lands once, so they stay out of the live bracket. */}
          {edges.length === 0 && nodes.length > 0 && (
            <DiagramFields
              scene={scene}
              onChange={changeDiagram}
              onPreviewSize={focused.previewSize}
              onPreviewStyle={focused.previewStyle}
            />
          )}
        </div>
      </aside>
    </ColorVariablesContext>
  );
}

const WIDTHS = [
  { id: "column", label: "Column", hint: "The text's width" },
  { id: "wide", label: "Wide", hint: "Past the text on both sides" },
] as const;

/**
 * The diagram itself: how wide its band is, how tall, and what it paints
 * behind its shapes. A band states no width of its own — it is the column's,
 * or wide — and is never shorter than what it holds. A storyboard shot's size
 * is its board's, so a frame shows its background alone.
 */
function DiagramFields({
  scene,
  onChange,
  onPreviewSize,
  onPreviewStyle,
}: {
  scene: Scene;
  onChange: (patch: DiagramPatch) => void;
  onPreviewSize?: (h: number) => void;
  onPreviewStyle?: (decls: StylePatch) => void;
}) {
  const framed = scene.w > 0;
  return (
    <PanelSection title={framed ? "Frame" : "Diagram"}>
      {!framed && (
        <>
          <div className="nt-ctl-row">
            <Segmented
              label="Width"
              segments={WIDTHS}
              value={scene.wide ? "wide" : "column"}
              onChange={(width) => onChange({ wide: width === "wide" })}
            />
          </div>
          <div className="nt-ctl-grid">
            <NumberField
              label="H"
              name="Diagram height"
              value={bandHeight(scene)}
              min={bandFloor(scene)}
              onChange={(h) => onChange({ h: Math.max(bandFloor(scene), h) })}
              onPreview={onPreviewSize}
            />
          </div>
        </>
      )}
      <div className="nt-ctl-row">
        <ColorField
          label="Background"
          value={scene.style.background ?? ""}
          // A raw `background` value already supports an authored gradient
          // (F20 in COLOR's own fixtures), so a Shift-pick may take the whole
          // paint here, unlike a plain stroke/effect colour field.
          accepts="paint"
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
 * The colour variables every target declares, as the focused diagram
 * declares them — a variable only some diagrams have is not one an edit
 * across all of them can bind to.
 */
function sharedVariables(targets: readonly PanelTarget[], own: StyleMap) {
  const mine = readColorVariables(own);
  if (targets.length < 2) return mine;
  return mine.filter((v) => targets.every((t) => t.scene.style[v.name] !== undefined));
}

/**
 * How long a run of typed panel edits stays one undo entry. A gesture says when
 * it ended and is bracketed by that; a keystroke does not, so it is closed by
 * quiet instead — 350ms is far longer than a repeat and shorter than the pause
 * between two edits you meant to make separately.
 */
const IDLE_MS = 350;

/** Ops for each store they belong to. */
export type PerStore = readonly (readonly [SceneStore, readonly SceneOp[]])[];

/**
 * One bracket over every store the panel is editing, closed as one step: a
 * slider dragged across a selection in three diagrams is one undo, in all
 * three. Each store's own bracket opens when a pointer goes down, or with the
 * first edit to reach it, and all of them close together.
 */
function useHistoryBracket(
  stores: readonly SceneStore[],
  focused: SceneStore,
  batch: <T>(fn: () => T) => T,
): {
  run: (ops: readonly SceneOp[]) => void;
  runEach: (each: PerStore) => void;
  live: LiveEdit;
} {
  const open = useRef(new Set<SceneStore>());
  /** Gestures currently holding the bracket open. */
  const held = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ stores, batch });
  useEffect(() => {
    latest.current = { stores, batch };
  });

  const close = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (open.current.size === 0) return;
    const closing = [...open.current];
    open.current.clear();
    latest.current.batch(() => closing.forEach((store) => store.commit()));
  }, []);

  const enter = useCallback((store: SceneStore) => {
    if (open.current.has(store)) return;
    open.current.add(store);
    store.begin();
  }, []);

  const live = useMemo<LiveEdit>(
    () => ({
      begin: () => {
        // Whatever the keyboard was writing ends here; this is its own entry.
        if (held.current === 0) close();
        held.current += 1;
        latest.current.stores.forEach(enter);
      },
      end: () => {
        if (held.current === 0) return;
        held.current -= 1;
        if (held.current === 0) close();
      },
    }),
    [close, enter],
  );

  const runEach = useCallback(
    (each: PerStore) => {
      if (!each.some(([, ops]) => ops.length)) return;
      for (const [store, ops] of each) {
        if (ops.length === 0) continue;
        // The last styling a shape was given is what the next one is drawn with.
        for (const op of ops) if (op.type === "setStyle") rememberStyle(op.decls);
        enter(store);
        store.dispatch([...ops]);
      }
      // Held: the gesture closes it. Otherwise only quiet can.
      if (held.current > 0) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(close, IDLE_MS);
    },
    [enter, close],
  );

  const run = useCallback(
    (ops: readonly SceneOp[]) => runEach([[focused, ops]]),
    [runEach, focused],
  );

  // An unmount mid-bracket would leave a store's depth above zero, which
  // blocks undo for the rest of the session.
  useEffect(
    () => () => {
      held.current = 0;
      close();
    },
    [close],
  );

  // An undo landing inside the idle window settles the typing run first, so
  // the step is not refused for a bracket whose gesture already ended. A
  // pointer still holding the bracket keeps it — undo mid-drag stays refused.
  // Reconciled every render, since the targets arrive as a fresh array each
  // time and only the stores in it matter — and those a bracket is still open
  // on, which the selection may have left mid-run.
  const watched = useRef(new Map<SceneStore, () => void>());
  useEffect(() => {
    const next = new Set(stores);
    for (const [store, off] of watched.current) {
      if (next.has(store) || open.current.has(store)) continue;
      off();
      watched.current.delete(store);
    }
    for (const store of next) {
      if (watched.current.has(store)) continue;
      watched.current.set(
        store,
        store.onBeforeStep(() => {
          if (held.current === 0) close();
        }),
      );
    }
  });
  useEffect(() => {
    const subscriptions = watched.current;
    return () => {
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
    };
  }, []);

  return { run, runEach, live };
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
  target: Pick<PanelTarget, "nodes" | "scene" | "band">,
  fn: (node: SceneNode) => Partial<SceneNode>,
): SceneOp[] {
  const frames: NodeFrame[] = [];
  const spins = new Map<number, NodeId[]>();
  const ops: SceneOp[] = [];

  for (const node of target.nodes) {
    const next = fn(node);

    if (
      next.x !== undefined ||
      next.y !== undefined ||
      next.w !== undefined ||
      next.h !== undefined
    ) {
      const frame = {
        id: node.id,
        x: next.x ?? node.x,
        y: next.y ?? node.y,
        w: next.w ?? node.w,
        h: next.h ?? node.h,
      };
      // A top-level shape stays in its band, however the number was typed —
      // a nested one is placed in its group, which the band already holds.
      const band = target.band;
      if (band && !findParent(target.scene, node.id)) {
        if (next.x !== undefined || next.w !== undefined) {
          frame.x = Math.max(band.minX, Math.min(band.maxX - frame.w, frame.x));
        }
        if (next.y !== undefined) frame.y = Math.max(0, frame.y);
      }
      frames.push(frame);
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
