"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  stepZoom,
  wheelZoom,
  zoomFor,
  type ZoomAnchor,
  type ZoomPane,
} from "@/app/lib/docZoom";

/** WebKit's trackpad pinch, which the DOM lib does not type. */
type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };

function safariPinch(): boolean {
  return "GestureEvent" in window && window.matchMedia("(pointer: fine)").matches;
}

/**
 * Binds a pane's page to its zoom store and to the pinch and ctrl-wheel over
 * it. A Chromium or Firefox trackpad pinch arrives as a ctrl-wheel; Safari's as
 * gesture events, taken only with a fine pointer so a touch pinch on iOS stays
 * the browser's. Anything under the pointer that zooms itself (the sidebar's
 * graph) prevents the default first and is left alone.
 */
export function useDocumentZoom(
  pane: ZoomPane | null,
  paneRef: RefObject<HTMLElement | null>,
  sheetRef: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const el = paneRef.current;
    const sheet = sheetRef.current;
    if (!pane || !el || !sheet) return;
    const store = zoomFor(pane);
    const detach = store.attach(el, sheet);

    // Coalesced to one apply a frame, at the last anchor.
    let target: number | null = null;
    let anchor: ZoomAnchor | undefined;
    let frame = 0;
    let pinchFrom: number | null = null;
    const flush = () => {
      frame = 0;
      if (target !== null) store.set(target, anchor);
      target = null;
    };
    const aim = (z: number, at: ZoomAnchor) => {
      target = z;
      anchor = at;
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (pinchFrom !== null) return;
      aim(wheelZoom(target ?? store.get(), e.deltaY, e.deltaMode, el.clientHeight), {
        x: e.clientX,
        y: e.clientY,
      });
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinchFrom = target ?? store.get();
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (pinchFrom === null) return;
      const g = e as GestureEvent;
      aim(pinchFrom * g.scale, { x: g.clientX, y: g.clientY });
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      pinchFrom = null;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    const gestures = safariPinch();
    if (gestures) {
      el.addEventListener("gesturestart", onGestureStart, { passive: false });
      el.addEventListener("gesturechange", onGestureChange, { passive: false });
      el.addEventListener("gestureend", onGestureEnd, { passive: false });
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("wheel", onWheel);
      if (gestures) {
        el.removeEventListener("gesturestart", onGestureStart);
        el.removeEventListener("gesturechange", onGestureChange);
        el.removeEventListener("gestureend", onGestureEnd);
      }
      detach();
    };
  }, [pane, paneRef, sheetRef]);
}

let applePlatform: boolean | null = null;
/** ⌘ on Apple, Ctrl elsewhere — the command modifier the browser's own zoom keys use. */
function isMod(e: KeyboardEvent): boolean {
  applePlatform ??= /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
  return applePlatform ? e.metaKey : e.ctrlKey;
}

/** In, out, or back to 100% — null for any key that is not a zoom key. */
export function zoomKey(e: Pick<KeyboardEvent, "key" | "code">): 1 | -1 | 0 | null {
  if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return 1;
  if (e.key === "-" || e.code === "NumpadSubtract") return -1;
  if (e.key === "0" || e.code === "Numpad0") return 0;
  return null;
}

/**
 * ⌘/Ctrl with = + - 0 zoom the page of the pane `getPane` names, ahead of
 * everything else on the document — including the browser, whose own zoom
 * would scale the whole app. ⌥ is left alone (⌘⌥0 turns a block into text).
 * A fullscreen shot or a dialog keeps the keys: the browser's zoom is still
 * refused there, but no page behind it moves.
 *
 * Also refuses the browser's zoom for a pinch or ctrl-wheel anywhere outside a
 * pane — over a rail, the toolbar — once nothing under it has taken the event.
 */
export function useZoomKeys(getPane: () => ZoomPane | null) {
  const latest = useRef(getPane);
  useEffect(() => {
    latest.current = getPane;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || e.altKey || e.isComposing) return;
      const dir = zoomKey(e);
      if (dir === null) return;
      e.preventDefault();
      const target = e.target;
      if (target instanceof Element && target.closest(".nt-sb-full, [role=dialog]")) return;
      e.stopPropagation();
      const pane = latest.current();
      if (!pane) return;
      const store = zoomFor(pane);
      if (dir === 0) store.reset();
      else store.set(stepZoom(store.get(), dir));
    };
    const swallow = (e: Event) => {
      if (e.defaultPrevented) return;
      if (e.type === "wheel" && !(e as WheelEvent).ctrlKey && !(e as WheelEvent).metaKey) return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", swallow, { passive: false });
    window.addEventListener("gesturestart", swallow, { passive: false });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", swallow);
      window.removeEventListener("gesturestart", swallow);
    };
  }, []);
}
