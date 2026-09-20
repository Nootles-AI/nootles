"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileDoc, Plus } from "./Icons";
import { NotionMark } from "./NotionMark";

/**
 * New project, and the other ways to start one — as a single surface.
 *
 * The button does not open a menu; it becomes it. The whole menu is always laid
 * out, anchored to the button's top-right corner and clipped down to the
 * button's rectangle. Opening animates the clip, so nothing is measured or
 * resized on the way and the header never moves. The plus turns away, the
 * label travels to the middle to become the panel's title, and the caret
 * settles into a minus, which is the way back.
 *
 * Deliberately NOT portaled, unlike every other overlay (see NT-52): the morph
 * requires the button and the menu to be one element. That is safe here and
 * only here — the projects screen has no `.nt-panel`, so there is no ancestor
 * stacking context to be capped by. Do not reuse this inside the workspace.
 */
export function CreateProject({
  notion,
  onBlank,
  onNotion,
}: {
  /** Whether there is anything besides a blank project to offer. */
  notion: boolean;
  onBlank: () => void;
  onNotion: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLButtonElement>(null);
  const caret = useRef<HTMLButtonElement>(null);
  const items = useRef<HTMLDivElement>(null);

  // The closed clip is the button's own width, which is its label's — so it is
  // read off the label, and re-read if the font swaps in or the text changes.
  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return;
    const measure = () =>
      root.current?.style.setProperty(
        "--w",
        `${el.offsetWidth + (caret.current?.offsetWidth ?? 0)}px`,
      );
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [notion]);

  useEffect(() => {
    if (!open) return;
    items.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  // Focus goes to the caret before the choice runs: both choices open a dialog,
  // which hands focus back to whatever had it — and the item that was pressed
  // is inert by then.
  const choose = (run: () => void) => {
    setOpen(false);
    caret.current?.focus({ preventScroll: true });
    run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      caret.current?.focus({ preventScroll: true });
      return;
    }
    if (e.key === "Tab") return setOpen(false);
    const list = Array.from(items.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === "ArrowDown"
        ? (at + 1) % list.length
        : e.key === "ArrowUp"
          ? (at - 1 + list.length) % list.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? list.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    list[to]?.focus({ preventScroll: true });
  };

  return (
    <div ref={root} className="nt-create" data-open={open} onKeyDown={onKeyDown}>
      <div className="nt-create-lift">
        <div className="nt-create-surface">
          <div className="nt-create-bar">
            {/* Open, this is the panel's title rather than a control: it stops
                taking the pointer and leaves the tab order, and "Blank project"
                below is the way to do what it did. */}
            <button
              ref={main}
              onClick={() => choose(onBlank)}
              tabIndex={open ? -1 : undefined}
              className="nt-create-main"
            >
              <Plus width={14} height={14} className="nt-create-plus" />
              <span className="nt-create-title">New project</span>
            </button>
            {notion && (
              <button
                ref={caret}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={open ? "Close" : "More ways to start"}
                className="nt-create-caret"
              >
                <CaretToMinus />
              </button>
            )}
          </div>

          {notion && (
            <div
              ref={items}
              role="menu"
              aria-label="Ways to start a project"
              inert={!open}
              className="nt-create-items"
            >
              <Way
                icon={<FileDoc />}
                name="Blank project"
                hint="A title and an empty first page"
                onClick={() => choose(onBlank)}
              />
              <div className="nt-create-sep" role="separator" />
              <div className="nt-create-label" role="presentation">
                Import from
              </div>
              <Way
                icon={<NotionMark />}
                name="Notion"
                hint="Choose which pages come across"
                onClick={() => choose(onNotion)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Way({
  icon,
  name,
  hint,
  onClick,
}: {
  icon: ReactNode;
  name: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button role="menuitem" onClick={onClick} className="nt-create-way">
      <span className="nt-create-tile">{icon}</span>
      <span className="nt-create-two">
        <span>{name}</span>
        <span>{hint}</span>
      </span>
    </button>
  );
}

/**
 * Two strokes meeting at the middle. Drawn flat — a minus — and each turned 45°
 * about the join while closed, which is a chevron. One glyph in two poses, so
 * the change is a movement rather than a swap.
 */
function CaretToMinus() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      className="nt-create-glyph"
    >
      <path d="M5 12h7" />
      <path d="M19 12h-7" />
    </svg>
  );
}
