"use client";

import { KeyboardEvent, RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { mapOffset, rebaseText } from "@/app/lib/rebaseText";

/**
 * A contentEditable text field. Unlike <input>, browsers never autofill a
 * contentEditable element, which is why we use it for titles (Chrome ignores
 * autoComplete="off" and clobbers plain inputs).
 *
 * Uncontrolled: the DOM owns the text, and `value` is what the outside world
 * holds. The field remembers its *base* — the last `value` its text was made
 * from. A `value` that arrives is one of three things:
 * - an echo of something typed here (an optimistic rename, a draft held one
 *   level up): it becomes the base and the text is left alone;
 * - a change from elsewhere with nothing typed since the base: adopted;
 * - a change from elsewhere while there is: what was typed is rebased onto it
 *   and reported through `onInput`, so the caller saves the merge rather than
 *   text written against a value that has since been replaced (NT-138).
 * Focus no longer decides whether a value is applied — a background tab keeps
 * its `activeElement` indefinitely — it only decides whether the caret is
 * carried across. Mid-composition the DOM is left to the IME and the value is
 * applied when the composition ends.
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
  baseRef,
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
  /** Kept at the field's base, for a caller that saves against it. */
  baseRef?: RefObject<string | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const base = useRef<string | null>(null);
  /** Texts reported since the base, oldest first — what an echo can be. */
  const sent = useRef<string[]>([]);
  const composing = useRef(false);
  const latest = useRef(value);
  const onInputRef = useRef(onInput);
  // Ahead of the reconciling effect below, and of any composition ending.
  useLayoutEffect(() => {
    latest.current = value;
    onInputRef.current = onInput;
  });

  const settle = (next: string) => {
    base.current = next;
    if (baseRef) baseRef.current = next;
  };

  const reconcile = () => {
    const el = ref.current;
    if (!el || composing.current) return;
    const incoming = latest.current;
    if (incoming === base.current) return;
    const text = el.textContent ?? "";
    const from = base.current;
    if (from === null) {
      // Mounting: the field starts empty.
      settle(incoming);
      write(el, text, incoming);
      return;
    }
    const echo = sent.current.indexOf(incoming);
    if (echo >= 0) {
      // Something typed here coming back; anything typed since stays put.
      sent.current = sent.current.slice(echo + 1);
      settle(incoming);
      return;
    }
    sent.current = [];
    settle(incoming);
    if (text === incoming) return;
    const merged = text === from ? incoming : rebaseText(from, text, incoming);
    write(el, text, merged);
    if (merged !== incoming) {
      sent.current.push(merged);
      onInputRef.current(merged);
    }
  };

  useEffect(reconcile, [value]); // eslint-disable-line react-hooks/exhaustive-deps

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
      onInput={(e) => {
        const text = e.currentTarget.textContent ?? "";
        sent.current.push(text);
        if (sent.current.length > 64) sent.current.shift();
        onInput(text);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        reconcile();
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        // A blur can cut a composition short without its end event.
        if (composing.current) {
          composing.current = false;
          reconcile();
        }
        onBlur?.();
      }}
      className={className}
    />
  );
}

/** Replace the field's text, carrying a caret or selection inside it across. */
function write(el: HTMLDivElement, from: string, to: string) {
  if (from === to) return;
  const sel = window.getSelection();
  const inside =
    document.activeElement === el && sel !== null && sel.rangeCount > 0 && el.contains(sel.anchorNode);
  const offsets = inside ? [offsetIn(el, sel.anchorNode!, sel.anchorOffset), offsetIn(el, sel.focusNode!, sel.focusOffset)] : null;
  el.textContent = to;
  if (!offsets) return;
  const [anchor, focus] = offsets.map((o) => mapOffset(from, to, o));
  const node = el.firstChild ?? el;
  sel!.setBaseAndExtent(node, node === el ? 0 : anchor, node, node === el ? 0 : focus);
}

/** A DOM position inside the field as a character offset into its text. */
function offsetIn(el: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(node, offset);
  return range.toString().length;
}
