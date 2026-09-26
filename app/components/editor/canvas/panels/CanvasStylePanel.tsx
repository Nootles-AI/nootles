"use client";

import { useSceneSnapshot } from "../engine/useScene";
import { useSelection } from "../engine/useSelection";
import type { CanvasApi } from "../render/CanvasSurface";
import { PickHostContext } from "./controls/colorPick";
import { StylePanel } from "./StylePanel";

/**
 * The style panel for one diagram. The panel wants the resolved selection;
 * the api carries the two stores — and is what its colour fields' eyedropper
 * samples.
 */
export function CanvasStylePanel({ api }: { api: CanvasApi }) {
  "use memo";
  const scene = useSceneSnapshot(api.store);
  const selection = useSelection(api.selection, scene);
  return (
    <PickHostContext value={api}>
      <StylePanel
        store={api.store}
        selection={selection.nodes}
        edges={selection.edges}
        onDiagramChange={api.setDiagram}
        onSelect={(ids) => api.selection.select(ids)}
        onPreviewSize={api.previewSize}
        onPreviewStyle={api.previewStyle}
      />
    </PickHostContext>
  );
}
