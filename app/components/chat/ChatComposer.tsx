"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * The ask box.
 *
 * Grows with what you type up to a ceiling, the way every chat composer does —
 * a fixed one-line box hides the paragraph you are trying to write, and a
 * fixed-tall one wastes the panel when you are asking a short question.
 */
export function ChatComposer({
  disabled,
  busy,
  onSend,
  onStop,
}: {
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured, not computed: reset first so the box can shrink again.
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    setText("");
    onSend(value);
  };

  return (
    <div className="ab-composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        aria-label="Ask auto-board"
        placeholder="Ask, or describe a change…"
        className="ab-composer-input"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift-Enter is a newline. Modifier-Enter also sends,
          // because people who use it expect it to.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="ab-composer-actions">
        {busy ? (
          <button className="ab-composer-send" onClick={onStop} title="Stop">
            Stop
          </button>
        ) : (
          <button
            className="ab-composer-send"
            onClick={submit}
            disabled={disabled || !text.trim()}
            title="Send (↵)"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
