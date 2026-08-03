"use client";

import { useEffect, useRef } from "react";

/**
 * MathLive's <math-field> web component. MathLive touches `window` on import,
 * so it's loaded lazily (client-only). We cache the element class at module
 * scope after the first load so subsequent fields mount **synchronously** —
 * critical for multi-row math blocks where a newly-added row must grab focus
 * within the same tick (an async mount loses focus to rapid keystrokes).
 */
type MFEClass = { new (): HTMLElement & { value: string } };
let CachedMFE: MFEClass | null = null;
let loadPromise: Promise<MFEClass> | null = null;

function loadMathfield(): MFEClass | Promise<MFEClass> {
  if (CachedMFE) return CachedMFE;
  if (!loadPromise) {
    loadPromise = import("mathlive").then((m) => {
      CachedMFE = m.MathfieldElement as unknown as MFEClass;
      return CachedMFE;
    });
  }
  return loadPromise;
}

/**
 * The field owns its value while you type; `onChange` fires on edit. `value` is
 * only pushed back in when it differs from what the field last emitted, so our
 * own round-tripped writes never disturb the caret — but an external change (an
 * accepted completion, an AI op, another synced tab) does land.
 *
 * `onTab` returns whether it consumed the key, which is how an accepted
 * completion takes Tab without stopping it from working normally otherwise.
 */
export function MathField({
  value,
  onChange,
  onBlur,
  onEnter,
  onBackspaceEmpty,
  onTab,
  onEscape,
  autoFocus = true,
}: {
  value: string;
  onChange: (latex: string) => void;
  onBlur?: () => void;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
  onTab?: () => boolean;
  onEscape?: () => void;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const fieldRef = useRef<(HTMLElement & { value: string }) | null>(null);
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onEnterRef = useRef(onEnter);
  const onBackspaceEmptyRef = useRef(onBackspaceEmpty);
  const onTabRef = useRef(onTab);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    onEnterRef.current = onEnter;
    onBackspaceEmptyRef.current = onBackspaceEmpty;
    onTabRef.current = onTab;
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    let cancelled = false;

    const mount = (Cls: MFEClass) => {
      if (cancelled || !host.current) return;
      const field = new Cls();
      fieldRef.current = field;
      field.value = lastEmitted.current;
      field.className = "nt-mathfield";
      field.addEventListener("input", () => {
        lastEmitted.current = field.value;
        onChangeRef.current(field.value);
      });
      field.addEventListener("blur", () => onBlurRef.current?.());
      field.addEventListener("keydown", (e) => {
        const key = (e as KeyboardEvent).key;
        if (key === "Enter") {
          e.preventDefault();
          onEnterRef.current?.();
        } else if (key === "Tab") {
          if (!onTabRef.current?.()) return;
          e.preventDefault();
          e.stopPropagation();
        } else if (key === "Escape") {
          onEscapeRef.current?.();
        } else if (
          key === "Backspace" &&
          field.value === "" &&
          onBackspaceEmptyRef.current
        ) {
          e.preventDefault();
          onBackspaceEmptyRef.current();
        }
      });
      host.current.appendChild(field);
      if (autoFocus) field.focus();
    };

    const loaded = loadMathfield();
    if (loaded instanceof Promise) loaded.then(mount);
    else mount(loaded);

    return () => {
      cancelled = true;
      fieldRef.current?.remove();
      fieldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field || value === lastEmitted.current) return;
    lastEmitted.current = value;
    field.value = value;
  }, [value]);

  return <span ref={host} className="nt-mathfield-host" />;
}
