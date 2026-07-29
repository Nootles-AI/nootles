"use client";

import { useEffect, useRef } from "react";
import type { MentionItem } from "@/app/lib/ai/chat/mentions";

/**
 * The "@" menu.
 *
 * The editor's "/" menu is BlockNote's, driven by a ProseMirror plugin; the
 * composer is a plain textarea, so this is the same grammar built by hand —
 * filter as you type, up and down to move, Enter to take it, Escape to leave.
 * The keys live with the textarea, which owns the caret; this draws the list and
 * keeps the chosen row in view.
 *
 * It opens above the box rather than at the caret. A textarea will not say where
 * its caret is on screen without a mirrored copy of itself, and a menu that
 * covers the conversation to sit beside a character is worse than one that
 * always appears in the same place.
 */
export function MentionMenu({
  id,
  items,
  active,
  onPick,
  onHover,
}: {
  id: string;
  items: MentionItem[];
  active: number;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div id={id} role="listbox" aria-label="Mention" className="ab-menu ab-mention-menu">
      {items.map((item, i) => (
        <button
          key={item.key}
          id={`${id}-${i}`}
          ref={i === active ? activeRef : undefined}
          role="option"
          aria-selected={i === active}
          className={`ab-menu-item ab-mention-item${i === active ? " is-active" : ""}`}
          // The textarea keeps the focus and therefore the caret: a menu that
          // took it would have to put the caret back where it found it.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          <span className="ab-mention-label">{item.label}</span>
          {item.hint && <span className="ab-mention-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
