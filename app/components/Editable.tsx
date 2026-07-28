"use client";

import { KeyboardEvent, useEffect, useRef } from "react";

/**
 * A contentEditable text field. Unlike <input>, browsers never autofill a
 * contentEditable element, which is why we use it for titles (Chrome ignores
 * autoComplete="off" and clobbers plain inputs). Uncontrolled by design: the
 * DOM owns the text while focused; we only push `value` in when the element is
 * not focused (external updates / page switches), so the caret never jumps.
 */
export function Editable({
  value,
  onInput,
  onKeyDown,
  onBlur,
  placeholder,
  className,
  autoFocus,
  label,
}: {
  value: string;
  onInput: (text: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Accessible name — role="textbox" is unlabelled without it. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement !== el && el.textContent !== value) {
      el.textContent = value;
    }
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoFocus) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // caret at end
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [autoFocus]);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={label ?? placeholder}
      spellCheck={false}
      translate="no"
      data-placeholder={placeholder}
      onInput={(e) => onInput(e.currentTarget.textContent ?? "")}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={className}
    />
  );
}
