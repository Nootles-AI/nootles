import { useEffect, useRef } from "react";
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import type { SuggestionMenuProps } from "@blocknote/react";
import "./slashMenu.css";

/**
 * The "/" menu, ours rather than BlockNote's.
 *
 * BlockNote's wrapper still owns everything that is really editor state —
 * loading the items for a query, all keyboard navigation, the aria wiring on
 * the contenteditable, positioning and dismissal. What it hands a component is
 * only `items`, `loadingState`, `selectedIndex` and a wrapped `onItemClick`, so
 * this file is the presentation and nothing else.
 *
 * Four things the wrapper does NOT do, and each is load-bearing:
 *  - the ids below. It sets `aria-activedescendant` on the contenteditable to
 *    `bn-suggestion-menu-item-<i>`, so a screen reader follows the caret's
 *    focus only if these exact ids exist.
 *  - `preventDefault` on mousedown. Without it the editor blurs on press and
 *    the caret is gone before the click resolves.
 *  - scrolling the selected row into view as the arrow keys move.
 *  - the empty state.
 */
export function SlashMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick,
}: SuggestionMenuProps<DefaultReactSuggestionItem>) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation happens above us, so the only way a row driven off the
  // bottom edge comes back into view is if we bring it.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // "loading-initial" is the first query on a cold menu: showing an empty
  // shell there reads as "no results" for a beat, which is a lie.
  if (loadingState === "loading-initial") return null;

  if (!items.length) {
    return (
      <div className="nt-menu nt-slash" id="bn-suggestion-menu" role="listbox">
        <div className="nt-slash-empty">No blocks match</div>
      </div>
    );
  }

  return (
    <div
      className="nt-menu nt-slash"
      id="bn-suggestion-menu"
      role="listbox"
      ref={listRef}
    >
      {items.map((item, i) => {
        const selected = i === selectedIndex;
        // Sections are derived from the item order, which is why the item list
        // keeps each group contiguous. Read off the neighbour rather than a
        // running variable: the row is a pure function of its position.
        const openGroup = item.group && item.group !== items[i - 1]?.group;
        return (
          <div key={`${item.group ?? ""}:${item.title}`}>
            {openGroup && <div className="nt-slash-group">{item.group}</div>}
            <div
              id={`bn-suggestion-menu-item-${i}`}
              role="option"
              aria-selected={selected}
              ref={selected ? selectedRef : undefined}
              className="nt-menu-item nt-slash-item"
              data-selected={selected || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onItemClick?.(item)}
            >
              <span className="nt-slash-icon" aria-hidden>
                {item.icon}
              </span>
              <span className="nt-slash-text">
                <span className="nt-slash-title">{item.title}</span>
                {item.subtext && (
                  <span className="nt-slash-sub">{item.subtext}</span>
                )}
              </span>
              {item.badge && <kbd className="nt-slash-badge">{item.badge}</kbd>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
