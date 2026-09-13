"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type ScreenSampler = { open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> };
type EyeDropperWindow = Window & { EyeDropper?: new () => ScreenSampler };
const subscribe = () => () => {};
const supported = () => typeof (window as EyeDropperWindow).EyeDropper === "function";

/** A rendered sRGB pixel, not the authored fill beneath the pointer. */
export function ScreenColorPicker({ onChange }: { onChange: (value: string) => void }) {
  const available = useSyncExternalStore(subscribe, supported, () => false);
  const controller = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => controller.current?.abort(), []);

  const sample = async () => {
    const EyeDropper = (window as EyeDropperWindow).EyeDropper;
    if (!EyeDropper || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setError("");
    try {
      // Must run directly in the trusted click, before any await/import.
      const result = await new EyeDropper().open({ signal: request.signal });
      if (!request.signal.aborted && /^#[\da-f]{6}$/i.test(result.sRGBHex)) onChange(result.sRGBHex);
    } catch (cause) {
      if (!request.signal.aborted && !(cause instanceof DOMException && cause.name === "AbortError")) {
        setError("Screen sampling could not start. Try again, or enter a colour below.");
      }
    } finally {
      controller.current = null;
      if (!request.signal.aborted) setPending(false);
    }
  };

  return (
    <div className="nt-screen-picker">
      <button type="button" className="nt-menu-item" disabled={!available || pending} onClick={() => void sample()}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m14 5 5 5M13 6l4-4 5 5-4 4M15 8 4 19l-2 3 3-1L17 10" />
        </svg>
        {pending ? "Choose a pixel · Esc to cancel" : "Sample screen colour"}
      </button>
      {!available && <p className="nt-ctl-note">Screen sampling is unavailable in this browser. Enter a colour or use a saved variable.</p>}
      {error && <p role="alert" className="nt-ctl-note">{error}</p>}
    </div>
  );
}
