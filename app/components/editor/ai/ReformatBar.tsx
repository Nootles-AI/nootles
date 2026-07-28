"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { ChevronLeft, ChevronRight } from "@/app/components/Icons";
import { hasSuggestion } from "./ghostText";
import type { ReformatState } from "./useReformat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

/**
 * A small bar beside the block it would reshape.
 *
 * Positioned from the block's own rect rather than the caret: the suggestion is
 * about the block you just left, so anchoring it to where the caret went would
 * point at the wrong thing.
 */
export function ReformatBar({
  editor,
  state,
  onAccept,
  onDismiss,
  onCycle,
}: {
  editor: Editor;
  state: ReformatState;
  onAccept: () => void;
  onDismiss: () => void;
  onCycle: (delta: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { candidates, index } = state;
  const many = candidates.length > 1;

  // Written straight onto the element rather than held in state: the position
  // is a measurement of someone else's layout, not derived data, and putting it
  // through state would mean a render at the wrong place first.
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;

    // The END of the run, because that is where the writing stopped and where
    // the eye already is.
    const last = state.blockIds[state.blockIds.length - 1] ?? state.blockId;
    const el = editor.domElement?.querySelector<HTMLElement>(
      `[data-id="${last}"]`,
    );
    if (!el) {
      bar.style.visibility = "hidden";
      return;
    }

    // A block spans the whole column, so its right edge is nowhere near short
    // text like "2 | 4". Measuring the text itself puts the bar beside the
    // words rather than out in the margin.
    const content = el.querySelector<HTMLElement>(".bn-inline-content") ?? el;
    const range = document.createRange();
    range.selectNodeContents(content);
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? content.getBoundingClientRect();
    range.detach?.();
    if (!rect.height) {
      bar.style.visibility = "hidden";
      return;
    }

    const width = bar.offsetWidth || 160;
    const gap = 10;
    // Beside the text, unless that would run off the edge — then underneath it.
    let left = rect.right + gap;
    let top = rect.top + rect.height / 2 - bar.offsetHeight / 2;
    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, rect.left);
      top = rect.bottom + 6;
    }
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(left)}px`;
    bar.style.visibility = "visible";
  }, [editor, state.blockId, state.blockIds, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (e.key === "Tab") {
        // Both lanes want Tab. The inline completion sits at the caret and is
        // the more immediate of the two, so it wins while it is showing and
        // this listener stays out of the way.
        if (hasSuggestion(editor.prosemirrorState)) return;
        e.preventDefault();
        onAccept();
      } else if (many && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        // Only claim the arrows when there is somewhere to cycle to.
        if (e.altKey) {
          e.preventDefault();
          onCycle(e.key === "ArrowRight" ? 1 : -1);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editor, onAccept, onDismiss, onCycle, many]);

  return (
    <div
      ref={ref}
      className="ab-reformat"
      // Hidden until measured, so it never flashes at the top-left corner.
      style={{ visibility: "hidden", zIndex: "var(--z-dropdown)" }}
      role="status"
      aria-label={`Reformat suggestion: ${candidates[index].label}`}
    >
      {many && (
        <>
          <button
            className="ab-reformat-step"
            onClick={() => onCycle(-1)}
            aria-label="Previous suggestion"
            title="Previous (⌥←)"
          >
            <ChevronLeft width={12} height={12} />
          </button>
          <span className="ab-reformat-count">
            {index + 1}/{candidates.length}
          </span>
          <button
            className="ab-reformat-step"
            onClick={() => onCycle(1)}
            aria-label="Next suggestion"
            title="Next (⌥→)"
          >
            <ChevronRight width={12} height={12} />
          </button>
        </>
      )}
      <button className="ab-reformat-apply" onClick={onAccept}>
        {candidates[index].label}
        <span className="ab-reformat-key">⇥</span>
      </button>
    </div>
  );
}
