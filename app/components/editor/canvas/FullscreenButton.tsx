"use client";

import { useState, useSyncExternalStore } from "react";
import { Tooltip } from "@/app/components/Tooltip";

const subscribe = (callback: () => void) => {
  document.addEventListener("fullscreenchange", callback);
  return () => document.removeEventListener("fullscreenchange", callback);
};

/** Fullscreen the shell, not the drawing: inspectors, menus and dialogs stay reachable. */
export function FullscreenButton() {
  const active = useSyncExternalStore(subscribe, () => !!document.fullscreenElement, () => false);
  const available = useSyncExternalStore(subscribe, () => !!document.fullscreenEnabled, () => false);
  const [error, setError] = useState("");
  const toggle = async () => {
    setError("");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setError("Fullscreen was blocked by the browser. Try its View menu.");
    }
  };
  const label = active ? "Exit fullscreen" : "Enter fullscreen";
  return (
    <>
      <Tooltip label={available ? label : "Use your browser’s View menu for fullscreen"}>
        <button type="button" className="nt-toolbar-btn" aria-label={label} aria-pressed={active} disabled={!available} onClick={() => void toggle()}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={active ? "M8 3v5H3m13-5v5h5M3 16h5v5m13-5h-5v5" : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"} />
          </svg>
        </button>
      </Tooltip>
      {error && <span role="alert" className="nt-fullscreen-error">{error}</span>}
    </>
  );
}
