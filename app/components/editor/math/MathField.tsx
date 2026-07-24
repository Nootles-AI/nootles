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
 * Uncontrolled by design: the field owns its value; `onChange` fires on edit,
 * `onBlur`/`onEnter`/`onBackspaceEmpty` let the caller react.
 */
export function MathField({
  initialValue,
  onChange,
  onBlur,
  onEnter,
  onBackspaceEmpty,
  autoFocus = true,
}: {
  initialValue: string;
  onChange: (latex: string) => void;
  onBlur?: () => void;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onEnterRef = useRef(onEnter);
  const onBackspaceEmptyRef = useRef(onBackspaceEmpty);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    onEnterRef.current = onEnter;
    onBackspaceEmptyRef.current = onBackspaceEmpty;
  });

  useEffect(() => {
    let field: (HTMLElement & { value: string }) | undefined;
    let cancelled = false;

    const mount = (Cls: MFEClass) => {
      if (cancelled || !host.current) return;
      field = new Cls();
      field.value = initialValue;
      field.className = "ab-mathfield";
      field.addEventListener("input", () => onChangeRef.current(field!.value));
      field.addEventListener("blur", () => onBlurRef.current?.());
      field.addEventListener("keydown", (e) => {
        const key = (e as KeyboardEvent).key;
        if (key === "Enter") {
          e.preventDefault();
          onEnterRef.current?.();
        } else if (
          key === "Backspace" &&
          field!.value === "" &&
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
      field?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <span ref={host} className="ab-mathfield-host" />;
}
