"use client";

import { createContext, useContext } from "react";
import { useSceneSnapshot } from "./engine/useScene";
import { useSelection } from "./engine/useSelection";
import { StylePanel } from "./panels/StylePanel";
import type { CanvasApi } from "./render/CanvasSurface";

/**
 * Which canvas the screen is speaking for.
 *
 * The layers panel, the style panel and the toolbar are the window's, not the
 * block's — a 600px column of a document has no room for them — so the shell
 * mounts them and the block only says which canvas is under the hand. One at a
 * time: a page may hold several diagrams, and a layer list is a list of one.
 */
export type ActiveCanvas = { blockId: string; api: CanvasApi };

export type CanvasShell = {
  active: ActiveCanvas | null;
  set: (next: ActiveCanvas | null) => void;
};

/** A canvas rendered outside the workspace simply has no shell to take over. */
const NO_SHELL: CanvasShell = { active: null, set: () => {} };

export const CanvasShellContext = createContext<CanvasShell>(NO_SHELL);

export function useCanvasShell(): CanvasShell {
  return useContext(CanvasShellContext);
}

/** The panel wants the resolved selection; the api carries the two stores. */
export function CanvasStylePanel({ api }: { api: CanvasApi }) {
  const scene = useSceneSnapshot(api.store);
  const selection = useSelection(api.selection, scene);
  return (
    <StylePanel
      store={api.store}
      selection={selection.nodes}
      onDiagramChange={api.setDiagram}
      onPreviewSize={api.previewSize}
      onPreviewStyle={api.previewStyle}
    />
  );
}
