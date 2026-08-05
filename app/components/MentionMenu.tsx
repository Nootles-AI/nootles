"use client";

import { useEffect, useRef } from "react";
import type { MentionItem } from "@/app/lib/ai/chat/mentions";

/**
 * The "@" menu.
 *
 * The editor's "/" menu is BlockNote's, driven by a ProseMirror plugin; the
 * chat composer and the canvas's label editor are not BlockNote, so this is the
 * same grammar built by hand — filter as you type, up and down to move, Enter
 * to take it, Escape to leave. The keys live with whoever owns the caret; this
 * draws the list and keeps the chosen row in view.
 *
 * Where it opens is the host's decision, via `className`: the composer anchors
 * it above the box (a textarea will not say where its caret is without a
 * mirrored copy of itself), the canvas at the caret it can measure.
 */
export function MentionMenu({
  id,
  items,
  active,
  onPick,
  onHover,
  className = "",
}: {
  id: string;
  items: MentionItem[];
  active: number;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
  className?: string;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      id={id}
      role="listbox"
      aria-label="Mention"
      className={`nt-menu nt-mention-menu${className ? ` ${className}` : ""}`}
    >
      {items.map((item, i) => (
        <button
          key={item.key}
          id={`${id}-${i}`}
          ref={i === active ? activeRef : undefined}
          role="option"
          aria-selected={i === active}
          className={`nt-menu-item nt-mention-item${i === active ? " is-active" : ""}`}
          // The host keeps the focus and therefore the caret: a menu that
          // took it would have to put the caret back where it found it.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="nt-mention-label">{item.label}</span>
          {item.hint && <span className="nt-mention-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
