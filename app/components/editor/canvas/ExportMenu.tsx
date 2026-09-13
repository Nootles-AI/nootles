"use client";

import { useRef, useState } from "react";
import { Menu, MenuItem } from "@/app/components/Menu";
import type { SceneStore } from "./engine/useScene";
import type { ViewportController } from "./engine/useViewport";
import { canvasPng, canvasSourceFile, downloadCanvas } from "./exportCanvas";

export function ExportMenu({ store, viewport }: { store: SceneStore; viewport: ViewportController }) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const raster = async (scale: number) => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      if (store.gesturing() || viewport.containerRef.current?.querySelector('[contenteditable="true"]')) throw new Error("Finish the current edit before exporting.");
      const scene = store.getScene();
      downloadCanvas(await canvasPng(scene, viewport, scale), `canvas@${scale}x.png`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Export failed. Check that the images and fonts are available, then try again."); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <>
    <Menu label="Export canvas" side="top" align="end" trigger={(props) => <button type="button" {...props} className="nt-toolbar-btn" aria-label={pending ? "Exporting canvas" : "Export canvas"} disabled={pending}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></svg>
    </button>}>
      {(close) => <>
        <MenuItem onClick={() => { downloadCanvas(canvasSourceFile(store.getScene()), "canvas.nml"); close(); }}>NML source · editable</MenuItem>
        {[1, 2, 3].map((scale) => <MenuItem key={scale} onClick={() => { close(); void raster(scale); }}>PNG image · {scale}×</MenuItem>)}
        <p className="nt-ctl-note max-w-64 px-3 py-2">PNG uses the browser rendering with 32 px padding. External images and fonts must allow export.</p>
      </>}
    </Menu>
    {pending && <span role="status" className="nt-fullscreen-error">Preparing canvas image…</span>}
    {error && <span role="alert" className="nt-fullscreen-error">{error}</span>}
  </>;
}
