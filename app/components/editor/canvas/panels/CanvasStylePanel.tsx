"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useSceneSnapshot, type SceneStore } from "../engine/useScene";
import { useSelection } from "../engine/useSelection";
import { NO_PAGE_CANVAS, type PageCanvas } from "../page/PageCanvas";
import type { CanvasApi } from "../render/CanvasSurface";
import { bandLeft, bandWidth } from "../scene/band";
import { selectedNodes, type Scene } from "../scene/types";
import { PickHostContext } from "./controls/colorPick";
import { StylePanel, type FocusedTarget, type PanelTarget } from "./StylePanel";

const NO_SCENES: readonly Scene[] = [];

/** Where a diagram's top-level shapes may go; a frame holds them some other way. */
function bandOf(scene: Scene) {
  if (scene.w > 0) return null;
  const minX = bandLeft(scene);
  return { minX, maxX: minX + bandWidth(scene) };
}

/** Several stores' scenes as one snapshot: the same array until one of them moves. */
function watchScenes(stores: readonly SceneStore[]) {
  let last: readonly Scene[] = NO_SCENES;
  return {
    subscribe: (listener: () => void) => {
      const offs = stores.map((store) => store.subscribe(listener));
      return () => offs.forEach((off) => off());
    },
    get: () => {
      const now = stores.map((store) => store.getScene());
      if (now.length !== last.length || now.some((scene, i) => scene !== last[i])) last = now;
      return last;
    },
  };
}

/**
 * Every diagram of the page holding shapes, and their scenes, kept current:
 * the panel edits all of them when the selection reaches into several.
 */
function usePageParts(canvas: PageCanvas) {
  const snapshot = useSyncExternalStore(
    canvas.selection.subscribe,
    canvas.selection.getSnapshot,
    canvas.selection.getSnapshot,
  );
  const holding = canvas.targets().filter((t) => snapshot.parts.get(t.blockId)?.ids.length);
  const key = holding.length > 1 ? holding.map((t) => t.blockId).join("\n") : "";
  const scenes = useMemo(
    () => watchScenes(key ? key.split("\n").flatMap((id) => canvas.get(id)?.api.store ?? []) : []),
    [canvas, key],
  );
  useSyncExternalStore(scenes.subscribe, scenes.get, scenes.get);
  return key ? holding : [];
}

/**
 * The style panel for the diagram the screen speaks for, and — when the page's
 * selection reaches into other diagrams too — for their shapes with it. The
 * api carries the focused diagram's stores, and is what the colour fields'
 * eyedropper samples.
 *
 * Not compiled: which diagrams hold shapes is read off the page during render,
 * and a memo keyed on the page alone would keep the first answer.
 */
export function CanvasStylePanel({ api, page }: { api: CanvasApi; page?: PageCanvas | null }) {
  const canvas = page ?? NO_PAGE_CANVAS;
  const scene = useSceneSnapshot(api.store);
  const selection = useSelection(api.selection, scene);
  const parts = usePageParts(canvas);
  const focusedId = canvas.entries().find((entry) => entry.api === api)?.blockId ?? "";

  const focused: FocusedTarget = {
    blockId: focusedId,
    store: api.store,
    scene,
    nodes: selection.nodes,
    edges: selection.edges,
    band: bandOf(scene),
    setDiagram: api.setDiagram,
    select: (ids) => api.selection.select(ids),
    previewSize: api.previewSize,
    previewStyle: api.previewStyle,
  };
  const targets: PanelTarget[] = parts.some((part) => part.blockId === focusedId)
    ? parts.map((part) => {
        if (part.blockId === focusedId) return focused;
        const own = part.store.getScene();
        return {
          blockId: part.blockId,
          store: part.store,
          scene: own,
          nodes: selectedNodes(own, part.selection.getSnapshot().ids),
          edges: [],
          band: bandOf(own),
          setDiagram: part.entry.api.setDiagram,
        };
      })
    : [focused];

  return (
    <PickHostContext value={api}>
      <StylePanel targets={targets} focused={focused} batch={canvas.batch} />
    </PickHostContext>
  );
}
