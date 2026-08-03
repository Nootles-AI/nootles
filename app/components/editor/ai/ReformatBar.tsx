"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { ChevronLeft, ChevronRight, Sparkle } from "@/app/components/Icons";
import { hasSuggestion } from "./ghostText";
import type { ReformatState } from "./useReformat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

/**
 * A small chip beside the block it would reshape, plus — when there is more
 * than one shape on offer — a counter at the foot of the window.
 *
 * They are separate because they are different things: the chip names what will
 * happen to the text it is touching, while the counter is a control for the set
 * of suggestions. Putting the counter in the chip made a one-word label read as
 * a toolbar.
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
        // ProseMirror runs its own keydown handling whether or not the default
        // was prevented, so without this BlockNote also nests the block and the
        // reformat lands indented.
        e.stopPropagation();
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
    <>
      <div
        ref={ref}
        className="nt-reformat"
        // Hidden until measured, so it never flashes at the top-left corner.
        style={{ visibility: "hidden", zIndex: "var(--z-dropdown)" }}
        role="status"
        aria-label={`Reformat suggestion: ${candidates[index].label}`}
      >
        <button className="nt-reformat-apply" onClick={onAccept}>
          <Sparkle className="nt-reformat-mark" aria-hidden />
          {candidates[index].label}
          <span className="nt-reformat-key">⇥</span>
        </button>
      </div>

      {many && (
        <div
          className="nt-reformat-switcher"
          style={{ zIndex: "var(--z-dropdown)" }}
        >
          <button
            className="nt-reformat-step"
            onClick={() => onCycle(-1)}
            aria-label="Previous suggestion"
            title="Previous (⌥←)"
          >
            <ChevronLeft width={12} height={12} />
          </button>
          <span className="nt-reformat-count">
            {index + 1}/{candidates.length}
          </span>
          <button
            className="nt-reformat-step"
            onClick={() => onCycle(1)}
            aria-label="Next suggestion"
            title="Next (⌥→)"
          >
            <ChevronRight width={12} height={12} />
          </button>
        </div>
      )}
    </>
  );
}
